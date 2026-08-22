import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool } from "../../db/client";
import {
  affiliates, driverShifts, drivers, emailAccounts, invoiceLines, invoices, messages,
  ticketDrafts, tickets, tripEvents, trips, users, vehicles,
} from "../../db/schema";
import {
  createReservationFromTicket,
  nextTripReference,
  reservationForTicket,
  suggestedReservation,
  vehicleClassFromText,
} from "../reservations";
import { actorFor, listTripEvents } from "../trip-events";

afterAll(async () => {
  await pool.end();
});

describe("vehicleClassFromText", () => {
  it("reads the plain words", () => {
    expect(vehicleClassFromText("Sedan")).toBe("SEDAN");
    expect(vehicleClassFromText("a large SUV please")).toBe("SUV");
    expect(vehicleClassFromText("minivan")).toBe("VAN");
  });

  it("prefers Sprinter over van when both appear", () => {
    // "Executive Sprinter van" is a Sprinter. Reading it as a van would send
    // a seven-seater to collect twelve people.
    expect(vehicleClassFromText("executive sprinter van")).toBe("SPRINTER");
  });

  it("refuses to guess at something that is not a class", () => {
    // "Something comfortable" defaulted to a sedan would quietly commit us to
    // the cheapest car for a customer who may have meant the largest.
    expect(vehicleClassFromText("something comfortable")).toBeNull();
    expect(vehicleClassFromText(null)).toBeNull();
    expect(vehicleClassFromText("")).toBeNull();
  });
});

async function reset() {
  await db.delete(tripEvents);
  await db.delete(invoiceLines);
  await db.delete(invoices);
  await db.delete(trips);
  await db.delete(driverShifts);
  await db.delete(drivers);
  await db.delete(affiliates);
  await db.delete(vehicles);
  await db.delete(ticketDrafts);
  await db.delete(messages);
  await db.delete(tickets);
  await db.delete(emailAccounts);
  await db.delete(users);

  const [account] = await db
    .insert(emailAccounts)
    .values({
      provider: "GMAIL",
      email: "support@ourcompany.example",
      encryptedRefreshToken: "x",
      tokenIv: "x",
      tokenAuthTag: "x",
    })
    .returning();
  accountId = account.id;
}

let accountId: string;

async function makeTicket() {
  const [t] = await db
    .insert(tickets)
    .values({
      subject: "Car to JFK on the 24th",
      requesterEmail: "ana@customer.example",
      requesterName: "Ana Costa",
      providerThreadId: `th-${Math.random().toString(36).slice(2)}`,
      emailAccountId: accountId,
      status: "OPEN",
    })
    .returning();
  return t;
}

const INPUT = {
  passengerName: "Ana Costa",
  pickupAddress: "230 Park Ave, New York, NY 10169",
  dropoffAddress: "JFK Terminal 4, Jamaica, NY 11430",
  pickupAtLocal: "2026-09-24T09:00",
  bookedHours: 3,
  vehicleClass: "SEDAN" as const,
};

describe("nextTripReference", () => {
  beforeEach(reset);

  it("starts at T-10000 on an empty desk", async () => {
    expect(await nextTripReference()).toBe("T-10000");
  });

  it("carries on from the highest already used", async () => {
    const ticket = await makeTicket();
    await db.insert(trips).values({
      reference: "T-10441", passengerName: "x", pickupAddress: "a", dropoffAddress: "b",
      pickupAt: new Date(), bookedHours: 2, vehicleClass: "SEDAN", ticketId: ticket.id,
    });
    expect(await nextTripReference()).toBe("T-10442");
  });

  it("does not reuse a reference after the newest trip is removed", async () => {
    // Counting rows would hand out T-10441 again and collide on the unique
    // index. The number has to come from the highest reference, not the count.
    await db.insert(trips).values([
      { reference: "T-10440", passengerName: "x", pickupAddress: "a", dropoffAddress: "b", pickupAt: new Date(), bookedHours: 2, vehicleClass: "SEDAN" },
      { reference: "T-10441", passengerName: "y", pickupAddress: "a", dropoffAddress: "b", pickupAt: new Date(), bookedHours: 2, vehicleClass: "SEDAN" },
    ]);
    await db.delete(trips).where(eq(trips.reference, "T-10441"));
    expect(await nextTripReference()).toBe("T-10441");
  });
});

describe("creating a reservation from a ticket", () => {
  beforeEach(reset);

  it("writes the booking and links it back to the ticket", async () => {
    const ticket = await makeTicket();
    const trip = await createReservationFromTicket(ticket.id, INPUT, await actorFor(undefined));

    expect(trip.reference).toBe("T-10000");
    expect(trip.ticketId).toBe(ticket.id);
    expect(trip.status).toBe("SCHEDULED");
    expect(trip.assignedKind).toBe("UNASSIGNED");
    // 9am in New York in September is 13:00 UTC, not 09:00.
    expect(trip.pickupAt.toISOString()).toBe("2026-09-24T13:00:00.000Z");
  });

  it("reads the pickup as New York time whatever the server thinks it is", async () => {
    const ticket = await makeTicket();
    // January: the same wall clock is an hour further from UTC.
    const trip = await createReservationFromTicket(
      ticket.id,
      { ...INPUT, pickupAtLocal: "2026-01-24T09:00" },
      await actorFor(undefined)
    );
    expect(trip.pickupAt.toISOString()).toBe("2026-01-24T14:00:00.000Z");
  });

  it("files the first line of the trip's history, naming the ticket", async () => {
    const [user] = await db
      .insert(users)
      .values({ name: "Amar Pant", email: "amar@desk.example", passwordHash: "x", role: "ADMIN" })
      .returning();
    const ticket = await makeTicket();
    const trip = await createReservationFromTicket(ticket.id, INPUT, await actorFor(user.id));

    const [event] = await listTripEvents(trip.id);
    expect(event.kind).toBe("CREATED");
    expect(event.actorName).toBe("Amar Pant");
    expect(event.source).toBe(`Ticket #${ticket.ticketNumber}`);
  });

  it("refuses a second reservation on the same ticket, naming the first", async () => {
    const ticket = await makeTicket();
    await createReservationFromTicket(ticket.id, INPUT, await actorFor(undefined));
    await expect(
      createReservationFromTicket(ticket.id, INPUT, await actorFor(undefined))
    ).rejects.toThrow(/T-10000 was already created from this ticket/);
    expect((await db.select().from(trips)).length).toBe(1);
  });

  it("refuses a ticket that does not exist", async () => {
    await expect(
      createReservationFromTicket("nope", INPUT, await actorFor(undefined))
    ).rejects.toThrow(/No ticket with id/);
  });

  it("refuses a pickup time that is not a time", async () => {
    const ticket = await makeTicket();
    await expect(
      createReservationFromTicket(ticket.id, { ...INPUT, pickupAtLocal: "soon" }, await actorFor(undefined))
    ).rejects.toThrow(/not a time/);
  });

  it("finds the reservation a ticket already has", async () => {
    const ticket = await makeTicket();
    expect(await reservationForTicket(ticket.id)).toBeNull();
    const made = await createReservationFromTicket(ticket.id, INPUT, await actorFor(undefined));
    expect((await reservationForTicket(ticket.id))?.id).toBe(made.id);
  });
});

describe("what the form opens with", () => {
  beforeEach(reset);

  it("offers what the draft kept", async () => {
    const ticket = await makeTicket();
    await db.insert(ticketDrafts).values({
      ticketId: ticket.id,
      bodyHtml: "<p>hello</p>",
      confirmations: [], questions: [], internalNotes: [],
      facts: {
        passengerName: "Ana Costa", passengerPhone: null, bookerName: "Ana Costa",
        bookerEmail: "ana@customer.example",
        pickupAddress: "230 Park Ave, New York, NY 10169",
        dropoffAddress: "JFK Terminal 4, Jamaica, NY 11430",
        stops: [], pickupAtLocal: "2026-09-24T09:00", vehicleClass: "SEDAN",
        passengerCount: 2, luggageCount: 2, flightNumber: "DL404",
      },
    });
    const suggested = await suggestedReservation(ticket.id);
    expect(suggested?.passengerName).toBe("Ana Costa");
    expect(suggested?.vehicleClass).toBe("SEDAN");
  });

  it("offers nothing rather than something invented when the draft predates this", async () => {
    // Drafts written before facts were kept have none. A blank form a person
    // fills in is honest; a plausible default they click past is not.
    const ticket = await makeTicket();
    await db.insert(ticketDrafts).values({
      ticketId: ticket.id, bodyHtml: "<p>hello</p>",
      confirmations: [], questions: [], internalNotes: [],
    });
    expect(await suggestedReservation(ticket.id)).toBeNull();
  });
});

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool } from "../../db/client";
import {
  affiliates, driverShifts, drivers, emailAccounts, invoiceLines, invoices, messages,
  ticketDrafts, tickets, tripEvents, trips, users, vehicles,
} from "../../db/schema";
import {
  quotedTripsFrom,
  createReservationFromTicket,
  nextTripReference,
  reservationForTicket,
  suggestedReservation,
} from "../reservations";
import { actorFor, listTripEvents } from "../trip-events";
import { OpsError } from "../errors";

afterAll(async () => {
  await pool.end();
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

describe("coordinates from the draft", () => {
  beforeEach(reset);

  async function draftWithCoords(ticketId: string) {
    await db.insert(ticketDrafts).values({
      ticketId,
      bodyHtml: "<p>hello</p>",
      confirmations: [], questions: [], internalNotes: [],
      facts: {
        passengerName: "Ana Costa", passengerPhone: null, bookerName: "Ana Costa",
        bookerEmail: "ana@customer.example",
        pickupAddress: "230 Park Ave, New York, NY 10169",
        dropoffAddress: "JFK Terminal 4, Jamaica, NY 11430",
        pickupLat: 40.7548, pickupLng: -73.9757, pickupState: "NY",
        dropoffLat: 40.6446, dropoffLng: -73.7822, dropoffState: "NY",
        stops: [], pickupAtLocal: "2026-09-24T09:00", vehicleClass: "SEDAN",
        passengerCount: 2, luggageCount: 2, flightNumber: "DL404",
      },
    });
  }

  it("keeps the geocode the draft already paid for", async () => {
    // Without this the rate cards have nothing to measure and quote() stays
    // written, tested and called by nothing.
    const ticket = await makeTicket();
    await draftWithCoords(ticket.id);
    const trip = await createReservationFromTicket(ticket.id, INPUT, await actorFor(undefined));

    const [row] = await db.select().from(trips).where(eq(trips.id, trip.id));
    expect(row.pickupLat).toBeCloseTo(40.7548, 4);
    expect(row.dropoffLng).toBeCloseTo(-73.7822, 4);
    // The state travels with the point: it is what a partner's coverage is
    // written in, and asking Google for it a second time would be paying
    // twice for an answer we already had.
    expect(row.pickupState).toBe("NY");
  });

  it("drops them when the dispatcher changed the address", async () => {
    // The coordinates belong to the address that was geocoded. Carried onto a
    // corrected address they would price the job from the wrong place, and
    // there would be nothing on the screen to say so.
    const ticket = await makeTicket();
    await draftWithCoords(ticket.id);
    const trip = await createReservationFromTicket(
      ticket.id,
      { ...INPUT, pickupAddress: "30 Hudson Yards, New York, NY 10001" },
      await actorFor(undefined)
    );

    const [row] = await db.select().from(trips).where(eq(trips.id, trip.id));
    expect(row.pickupLat).toBeNull();
    expect(row.pickupLng).toBeNull();
    expect(row.pickupState).toBeNull();
    // The drop-off was not touched, so it keeps its point.
    expect(row.dropoffLat).toBeCloseTo(40.6446, 4);
  });

  it("stores nothing when the draft predates coordinates", async () => {
    const ticket = await makeTicket();
    await db.insert(ticketDrafts).values({
      ticketId: ticket.id, bodyHtml: "<p>hello</p>",
      confirmations: [], questions: [], internalNotes: [],
      facts: {
        passengerName: "Ana Costa", passengerPhone: null, bookerName: null, bookerEmail: null,
        pickupAddress: "230 Park Ave, New York, NY 10169",
        dropoffAddress: "JFK Terminal 4, Jamaica, NY 11430",
        stops: [], pickupAtLocal: "2026-09-24T09:00", vehicleClass: "SEDAN",
        passengerCount: null, luggageCount: null, flightNumber: null,
      },
    });
    const trip = await createReservationFromTicket(ticket.id, INPUT, await actorFor(undefined));
    const [row] = await db.select().from(trips).where(eq(trips.id, trip.id));
    expect(row.pickupLat).toBeNull();
    expect(row.dropoffLat).toBeNull();
  });
});

describe("two people, one ticket", () => {
  beforeEach(reset);

  it("lets the database have the final say, not the check above it", async () => {
    // createReservationFromTicket reads then writes, and those are two
    // moments. The polite refusal is for the message; the unique index is what
    // makes it true.
    const ticket = await makeTicket();
    const first = await createReservationFromTicket(ticket.id, INPUT, await actorFor(undefined));

    // The constraint name lives on the driver error, which Drizzle wraps in a
    // generic "Failed query" — so the chain has to be walked. That wrapping is
    // exactly what stopped the retry working on the first attempt at this fix.
    const constraint = await db
      .insert(trips)
      .values({
        reference: "T-19999", ticketId: ticket.id, passengerName: "Ana Costa",
        pickupAddress: "a", dropoffAddress: "b", pickupAt: new Date(),
        bookedHours: 2, vehicleClass: "SEDAN",
      })
      .then(() => null)
      .catch((err) => {
        for (let e = err; e; e = e.cause) if (e.code === "23505") return e.constraint;
        return `not a unique violation: ${err.message}`;
      });
    expect(constraint).toBe("trips_ticket_unique");

    expect((await db.select().from(trips)).map((t) => t.reference)).toEqual([first.reference]);
  });

  it("makes one reservation, not two, when both presses land together", async () => {
    const ticket = await makeTicket();
    const actor = await actorFor(undefined);

    const results = await Promise.allSettled([
      createReservationFromTicket(ticket.id, INPUT, actor),
      createReservationFromTicket(ticket.id, INPUT, actor),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await db.select().from(trips))).toHaveLength(1);

    // And the loser is told which reservation already exists, not handed a 500.
    const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(refused.reason).toBeInstanceOf(OpsError);
    expect(refused.reason.status).toBe(409);
    expect(refused.reason.message).toMatch(/already created from this ticket/);
  });

  it("gives two different tickets two different references, at the same instant", async () => {
    // Both draw the same highest number, one loses on trips_reference_unique,
    // and the retry re-reads a maximum the winner has already moved. Before
    // the retry this was a 500 for whoever came second.
    const a = await makeTicket();
    const b = await makeTicket();
    const actor = await actorFor(undefined);

    const [one, two] = await Promise.all([
      createReservationFromTicket(a.id, INPUT, actor),
      createReservationFromTicket(b.id, INPUT, actor),
    ]);

    expect(one.reference).not.toBe(two.reference);
    expect(new Set([one.reference, two.reference]).size).toBe(2);
    expect((await db.select().from(trips))).toHaveLength(2);
  });

  it("survives a crowd", async () => {
    const tickets = await Promise.all([1, 2, 3, 4, 5, 6].map(() => makeTicket()));
    const actor = await actorFor(undefined);

    const made = await Promise.all(
      tickets.map((t) => createReservationFromTicket(t.id, INPUT, actor))
    );

    expect(new Set(made.map((m) => m.reference)).size).toBe(6);
  });
});

describe("which booking an email is about", () => {
  // "Can we move T-10005 an hour later" is not a new reservation. Offering to
  // make one beside the booking they want moved is how a customer ends up with
  // two cars — the third of the three ways this system had of doing that.
  const trip = (over: Record<string, unknown> = {}) =>
    ({
      id: "t1", reference: "T-10005", pickupAt: new Date("2026-07-23T20:30:00Z"),
      bookedHours: 3, vehicleClass: "SUV", status: "COMPLETED",
      passengerName: "Ana Costa", pickupAddress: "1 Hotel Brooklyn Bridge",
      dropoffAddress: "Teterboro Airport",
      driver: { name: "Kwame Boateng" }, affiliate: null,
      ...over,
    }) as never;

  it("offers the booking the customer named", () => {
    const quoted = quotedTripsFrom({ trips: [{ reason: "QUOTED_IN_EMAIL", trip: trip() }] });
    expect(quoted).toHaveLength(1);
    expect(quoted[0].reference).toBe("T-10005");
    expect(quoted[0].driverName).toBe("Kwame Boateng");
  });

  it("ignores bookings that merely belong to the same sender", () => {
    // Guessing from history is how the wrong booking gets changed. Only a
    // reference the customer actually wrote counts.
    const quoted = quotedTripsFrom({
      trips: [
        { reason: "SENDER_RECENT", trip: trip({ id: "t2", reference: "T-10001" }) },
        { reason: "SENDER_UPCOMING", trip: trip({ id: "t3", reference: "T-10002" }) },
        { reason: "QUOTED_IN_EMAIL", trip: trip() },
      ],
    });
    expect(quoted.map((q) => q.reference)).toEqual(["T-10005"]);
  });

  it("says nothing when the email names no booking", () => {
    expect(quotedTripsFrom({ trips: [] })).toEqual([]);
  });

  it("carries the partner through when a job was farmed out", () => {
    const quoted = quotedTripsFrom({
      trips: [{
        reason: "QUOTED_IN_EMAIL",
        trip: trip({ driver: null, affiliate: { company: "Beacon Hill Chauffeurs" } }),
      }],
    });
    expect(quoted[0].driverName).toBeNull();
    expect(quoted[0].affiliateCompany).toBe("Beacon Hill Chauffeurs");
  });
});

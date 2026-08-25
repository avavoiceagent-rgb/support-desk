import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { DateTime } from "luxon";
import { db, pool } from "../../db/client";
import {
  emailAccounts,
  notes,
  ticketDrafts,
  tickets,
  trips,
  type DraftFacts,
} from "../../db/schema";
import { carryOntoBooking } from "../draft.service";
import { listTripEvents } from "../../ops/trip-events";
import { OPERATING_TIME_ZONE } from "../../booking/pickup-time";

// The path the whole thing exists for: a customer replies, and the car that is
// already booked has to move. Run against a real database because the two
// things most likely to break it are a database's business — a note with no
// author, and a trip patch carrying columns no screen ever sends.

const at = (iso: string) =>
  DateTime.fromISO(iso, { zone: OPERATING_TIME_ZONE }).toJSDate();
const localOf = (d: Date) =>
  DateTime.fromJSDate(d).setZone(OPERATING_TIME_ZONE).toFormat("yyyy-MM-dd HH:mm");

const NO_FACTS: DraftFacts = {
  passengerName: null,
  passengerPhone: null,
  bookerName: null,
  bookerEmail: null,
  pickupAddress: null,
  dropoffAddress: null,
  stops: [],
  pickupAtLocal: null,
  vehicleClass: null,
  passengerCount: null,
  luggageCount: null,
  flightNumber: null,
};

let ticketId = "";

async function makeTicketWithBooking(over: Partial<typeof trips.$inferInsert> = {}) {
  const [account] = await db
    .insert(emailAccounts)
    .values({
      email: "desk@example.test",
      provider: "GMAIL",
      encryptedRefreshToken: "x",
      tokenIv: "x",
      tokenAuthTag: "x",
      status: "connected",
    })
    .returning();

  const [ticket] = await db
    .insert(tickets)
    .values({
      emailAccountId: account.id,
      providerThreadId: `manual-${Math.random()}`,
      subject: "Airport transfer",
      requesterEmail: "apurva@customer.example",
      queue: "RESERVATION",
    })
    .returning();
  ticketId = ticket.id;

  await db.insert(ticketDrafts).values({
    ticketId: ticket.id,
    bodyHtml: "<p>draft</p>",
    confirmations: [],
    questions: [],
    internalNotes: [],
    facts: NO_FACTS,
  });

  const [trip] = await db
    .insert(trips)
    .values({
      reference: `T-${10_000 + Math.floor(Math.random() * 8000)}`,
      ticketId: ticket.id,
      passengerName: "Apurva Patel",
      pickupAddress: "1 Kalisa Way, Paramus",
      dropoffAddress: "LaGuardia Airport (LGA)",
      // The international time, which is what the draft books when nobody has
      // said which kind of flight it is.
      pickupAt: at("2026-09-03T13:55"),
      bookedHours: 3,
      vehicleClass: "SEDAN",
      flightAt: at("2026-09-03T17:45"),
      ...over,
    })
    .returning();

  return { ticket, trip };
}

async function reset() {
  await db.delete(trips);
  await db.delete(tickets);
  await db.delete(emailAccounts);
}

beforeEach(reset);
afterAll(async () => {
  await reset();
  await pool.end();
});

describe("a reply reaching the booking", () => {
  it("moves the car when the flight turns out to be domestic, and says so", async () => {
    const { trip } = await makeTicketWithBooking();

    await carryOntoBooking(ticketId, { ...NO_FACTS, flightKind: "DOMESTIC" }, [
      "Flight kind: international → domestic",
    ]);

    const [after] = await db.select().from(trips).where(eq(trips.id, trip.id));
    expect(localOf(after.pickupAt)).toBe("2026-09-03 14:55");
    expect(after.flightKind).toBe("DOMESTIC");

    const [note] = await db.select().from(notes).where(eq(notes.ticketId, ticketId));
    // Adam's, not the last person to touch the ticket.
    expect(note.authorId).toBeNull();
    expect(note.body).toContain("Pickup moved");
    expect(note.body).toContain(trip.reference);
  });

  it("records the move in the trip's own history so a driver can be told", async () => {
    const { trip } = await makeTicketWithBooking();

    await carryOntoBooking(ticketId, { ...NO_FACTS, flightKind: "DOMESTIC" }, ["kind"]);

    const events = await listTripEvents(trip.id);
    const fields = events.flatMap((e) => e.changes.map((c) => c.field));
    expect(fields).toContain("Pickup");
    expect(fields).toContain("Flight");
    expect(events.at(-1)!.actorName).toBe("Adam");
  });

  it("tells you the driver still thinks the old time stands", async () => {
    const { trip } = await makeTicketWithBooking();
    const [driver] = await db
      .insert((await import("../../db/schema")).drivers)
      .values({ name: "Amrit Singh", phone: "+1 917 555 0100" })
      .returning();
    await db.update(trips).set({ driverId: driver.id }).where(eq(trips.id, trip.id));

    await carryOntoBooking(ticketId, { ...NO_FACTS, flightKind: "DOMESTIC" }, ["kind"]);

    const [note] = await db.select().from(notes).where(eq(notes.ticketId, ticketId));
    expect(note.body).toContain("Amrit Singh");
    expect(note.body).toContain("Send them the change");
  });

  it("writes a note but touches nothing when no reservation exists yet", async () => {
    await makeTicketWithBooking();
    await db.delete(trips);

    await carryOntoBooking(ticketId, { ...NO_FACTS, passengerPhone: "201-555-0134" }, [
      "Contact number: 201-555-0134",
    ]);

    const [note] = await db.select().from(notes).where(eq(notes.ticketId, ticketId));
    expect(note.authorId).toBeNull();
    expect(note.body).toContain("No reservation has been created");
  });

  it("leaves a completed job exactly as it ran", async () => {
    const { trip } = await makeTicketWithBooking({ status: "COMPLETED" });

    await carryOntoBooking(ticketId, { ...NO_FACTS, flightKind: "DOMESTIC" }, ["kind"]);

    const [after] = await db.select().from(trips).where(eq(trips.id, trip.id));
    expect(localOf(after.pickupAt)).toBe("2026-09-03 13:55");
    expect(after.flightKind).toBeNull();
  });
});

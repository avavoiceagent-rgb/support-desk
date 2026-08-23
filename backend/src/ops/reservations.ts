// Turning an agreed booking into a reservation.
//
// This is the step between "the customer has been answered" and "a car is
// committed", and it is deliberately a button somebody presses rather than
// something that happens on send. Adam's first reply is usually a question —
// "are you booking for yourself or for someone else?" — and a reservation
// created off the back of a question is a car held for a booking nobody has
// agreed to.
//
// The facts the draft kept are a starting point, not an authority. They are
// offered to a person, who confirms or corrects them, and what that person
// submits is what gets written. A booking made from a model's reading without
// anybody checking is exactly the confident wrong answer this system is built
// to avoid.

import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { db } from "../db/client";
import { ticketDrafts, tickets, trips, type DraftFacts, type VehicleClass } from "../db/schema";
import { OPERATING_TIME_ZONE } from "../booking/pickup-time";
import { OpsError } from "./errors";
import { selectTrips, toTripRecord, type TripRecord } from "./lookup";
import { recordTripEvent, type Actor } from "./trip-events";

/** Where the reference numbers start, when there are none yet. */
const FIRST_REFERENCE = 10_000;

/**
 * How many times to re-draw a reference before giving up.
 *
 * Two people creating a reservation in the same second both read the same
 * highest number and the second insert loses on the unique index. Retrying
 * re-reads the maximum, which the first insert has now moved, so the second
 * attempt succeeds. Five is far more than a desk of this size will ever need
 * and still terminates if something else is wrong.
 */
const REFERENCE_ATTEMPTS = 5;

/**
 * Postgres unique-violation, and which constraint it was.
 *
 * Walks the cause chain: Drizzle wraps the driver's error, so the `code` and
 * `constraint` a caller wants are one or two levels down and reading them off
 * the top object silently finds nothing. That is exactly how this went wrong
 * the first time — the retry never fired and the test caught it.
 */
function uniqueViolation(err: unknown): string | null {
  for (let e = err as { code?: string; constraint?: string; cause?: unknown } | undefined; e; ) {
    if (e.code === "23505") return e.constraint ?? "";
    e = e.cause as typeof e;
  }
  return null;
}

// Moved to booking/vehicles.ts, where it sits beside the capacity rules that
// should have been deciding this all along. Re-exported because draft.service
// and the tests already import it from here.
export { vehicleClassFromText, vehicleClassFor } from "../booking/vehicles";

/** The next T- reference, one past the highest already used. */
export async function nextTripReference(): Promise<string> {
  // Read the number out of the reference rather than counting rows: trips get
  // deleted in tests and seeded in blocks, and a count would start handing out
  // references that already exist.
  const [row] = await db
    .select({
      highest: sql<number>`coalesce(max(nullif(regexp_replace(${trips.reference}, '\\D', '', 'g'), '')::bigint), 0)`,
    })
    .from(trips);
  const next = Math.max(Number(row?.highest ?? 0) + 1, FIRST_REFERENCE);
  return `T-${next}`;
}

export interface ReservationInput {
  passengerName: string;
  passengerPhone?: string | null;
  bookerName?: string | null;
  bookerEmail?: string | null;
  pickupAddress: string;
  dropoffAddress: string;
  stops?: string[];
  /** New York wall clock, "2026-09-22T09:00" — what the person saw and agreed. */
  pickupAtLocal: string;
  bookedHours: number;
  vehicleClass: VehicleClass;
  passengerCount?: number | null;
  luggageCount?: number | null;
  flightNumber?: string | null;
  notes?: string | null;
}

/** The trip already made from this ticket, if there is one. */
export async function reservationForTicket(ticketId: string): Promise<TripRecord | null> {
  const rows = await selectTrips().where(eq(trips.ticketId, ticketId)).limit(1);
  return rows.length ? toTripRecord(rows[0]) : null;
}

/**
 * What to put in the form, from what the draft kept.
 *
 * Null where the desk never established something. A blank field a person has
 * to fill is honest; a plausible default they will click past is not.
 */
export async function suggestedReservation(ticketId: string): Promise<DraftFacts | null> {
  const [draft] = await db
    .select({ facts: ticketDrafts.facts })
    .from(ticketDrafts)
    .where(and(eq(ticketDrafts.ticketId, ticketId), isNotNull(ticketDrafts.facts)))
    .orderBy(desc(ticketDrafts.createdAt))
    .limit(1);
  return draft?.facts ?? null;
}

/**
 * The insert, with the two ways it can lose a race handled differently.
 *
 * A clashing reference is nobody's fault and nobody's business — draw another
 * and carry on. A clashing ticket means somebody else just made this exact
 * reservation, which the person pressing the button needs to be told, in the
 * same words the polite check above them uses.
 */
async function insertReservation(
  values: Omit<typeof trips.$inferInsert, "reference">
): Promise<typeof trips.$inferSelect> {
  for (let attempt = 1; ; attempt++) {
    try {
      const [row] = await db
        .insert(trips)
        .values({ ...values, reference: await nextTripReference() })
        .returning();
      return row;
    } catch (err) {
      const constraint = uniqueViolation(err);
      if (constraint === "trips_ticket_unique") {
        const existing = values.ticketId ? await reservationForTicket(values.ticketId) : null;
        throw new OpsError(
          existing
            ? `${existing.reference} was already created from this ticket. Change that one rather than making a second.`
            : "A reservation was already created from this ticket.",
          409
        );
      }
      if (constraint === "trips_reference_unique" && attempt < REFERENCE_ATTEMPTS) continue;
      throw err;
    }
  }
}

export interface QuotedTrip {
  id: string;
  reference: string;
  pickupAt: Date;
  bookedHours: number;
  vehicleClass: string;
  status: string;
  passengerName: string;
  pickupAddress: string;
  dropoffAddress: string;
  driverName: string | null;
  affiliateCompany: string | null;
}

/**
 * The bookings this email actually names.
 *
 * "Can we move T-10005 an hour later" is not a new reservation, and offering
 * to make one beside the booking they want moved is how a customer ends up
 * with two cars. The desk already resolves the reference — this is what lets a
 * screen act on it.
 *
 * Quoted only. A trip that merely belongs to the same sender is not what they
 * are talking about, and guessing from history is how the wrong booking gets
 * changed.
 */
export function quotedTripsFrom(context: {
  trips: { reason: string; trip: TripRecord }[];
}): QuotedTrip[] {
  return context.trips
    .filter((t) => t.reason === "QUOTED_IN_EMAIL")
    .map(({ trip }) => ({
      id: trip.id,
      reference: trip.reference,
      pickupAt: trip.pickupAt,
      bookedHours: trip.bookedHours,
      vehicleClass: trip.vehicleClass,
      status: trip.status,
      passengerName: trip.passengerName,
      pickupAddress: trip.pickupAddress,
      dropoffAddress: trip.dropoffAddress,
      driverName: trip.driver?.name ?? null,
      affiliateCompany: trip.affiliate?.company ?? null,
    }));
}

export async function createReservationFromTicket(
  ticketId: string,
  input: ReservationInput,
  actor: Actor
): Promise<TripRecord> {
  const [ticket] = await db.select().from(tickets).where(eq(tickets.id, ticketId)).limit(1);
  if (!ticket) throw new OpsError(`No ticket with id ${ticketId}.`, 404);

  // One ticket, one reservation. Two people working the same ticket at once is
  // ordinary, and the second press must not quietly commit a second car.
  const already = await reservationForTicket(ticketId);
  if (already) {
    throw new OpsError(
      `${already.reference} was already created from this ticket. Change that one rather than making a second.`,
      409
    );
  }

  const pickup = DateTime.fromISO(input.pickupAtLocal, { zone: OPERATING_TIME_ZONE });
  if (!pickup.isValid) {
    throw new OpsError("That pickup time is not a time. Use the date and time boxes.");
  }

  const row = await insertReservation({
    ticketId,
    passengerName: input.passengerName,
    passengerPhone: input.passengerPhone ?? null,
    bookerName: input.bookerName ?? null,
    bookerEmail: input.bookerEmail ?? null,
    pickupAddress: input.pickupAddress,
    dropoffAddress: input.dropoffAddress,
    stops: input.stops ?? [],
    pickupAt: pickup.toJSDate(),
    bookedHours: input.bookedHours,
    vehicleClass: input.vehicleClass,
    passengerCount: input.passengerCount ?? null,
    luggageCount: input.luggageCount ?? null,
    flightNumber: input.flightNumber ?? null,
    status: "SCHEDULED",
    assignedKind: "UNASSIGNED",
    notes: input.notes ?? null,
  });

  await recordTripEvent({
    tripId: row.id,
    actor,
    kind: "CREATED",
    source: `Ticket #${ticket.ticketNumber}`,
    changes: [
      { field: "Pickup", from: null, to: pickup.toFormat("d LLL yyyy, h:mm a") },
      { field: "Hours booked", from: null, to: String(input.bookedHours) },
      { field: "Car", from: null, to: input.vehicleClass },
    ],
  });

  const created = await selectTrips().where(eq(trips.id, row.id)).limit(1);
  return toTripRecord(created[0]);
}

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

const CLASS_WORDS: [RegExp, VehicleClass][] = [
  // Order matters: "executive sprinter van" is a Sprinter, not a van.
  [/\bsprinter\b/i, "SPRINTER"],
  [/\b(?:mini)?van\b/i, "VAN"],
  [/\b(?:suv|escalade|suburban|navigator)\b/i, "SUV"],
  [/\b(?:sedan|saloon|town\s*car)\b/i, "SEDAN"],
];

/**
 * The class of car a free-text request means, or null.
 *
 * Null rather than a guess. "Something comfortable" is not a vehicle class,
 * and defaulting it to a sedan would quietly commit us to the cheapest car
 * for a customer who may have meant the largest.
 */
export function vehicleClassFromText(text: string | null | undefined): VehicleClass | null {
  if (!text) return null;
  for (const [pattern, cls] of CLASS_WORDS) {
    if (pattern.test(text)) return cls;
  }
  return null;
}

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

  const [row] = await db
    .insert(trips)
    .values({
      reference: await nextTripReference(),
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
    })
    .returning();

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

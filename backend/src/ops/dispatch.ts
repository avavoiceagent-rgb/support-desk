// Talking to a driver or a partner about a job.
//
// Not SMS. A page they open costs nothing, needs no provider and no phone
// numbers, and is how dispatch mostly works now — the text message is the
// fallback, not the channel.
//
// The one rule that makes this more than a chat log: accepting an offer
// actually assigns the driver, and it goes through updateTrip to get there.
// That means the double-booking refusal applies to an acceptance exactly as it
// applies to a dispatcher dragging somebody onto a job, and the trip's history
// records it. Two paths to the same change with two sets of rules is how a
// system starts contradicting itself.

import { and, asc, eq, isNull, or } from "drizzle-orm";
import { DateTime } from "luxon";
import { db } from "../db/client";
import { affiliates, dispatchMessages, drivers, trips } from "../db/schema";
import { OPERATING_TIME_ZONE } from "../booking/pickup-time";
import { OpsError } from "./errors";
import { selectTrips, toTripRecord, type TripRecord } from "./lookup";
import { updateTrip } from "./trips";
import type { Actor } from "./trip-events";

export type DispatchMessage = typeof dispatchMessages.$inferSelect;

export interface Contact {
  kind: "DRIVER" | "AFFILIATE";
  id: string;
}

/** Exactly one of driver or partner, never both and never neither. */
function contactFilter(contact: Contact) {
  return contact.kind === "DRIVER"
    ? and(eq(dispatchMessages.driverId, contact.id), isNull(dispatchMessages.affiliateId))
    : and(eq(dispatchMessages.affiliateId, contact.id), isNull(dispatchMessages.driverId));
}

async function requireContact(contact: Contact): Promise<string> {
  if (contact.kind === "DRIVER") {
    const [row] = await db.select().from(drivers).where(eq(drivers.id, contact.id)).limit(1);
    if (!row) throw new OpsError(`No driver with id ${contact.id}.`, 404);
    return row.name;
  }
  const [row] = await db.select().from(affiliates).where(eq(affiliates.id, contact.id)).limit(1);
  if (!row) throw new OpsError(`No partner with id ${contact.id}.`, 404);
  return row.company;
}

/** The whole conversation, oldest first — a thread is read forwards. */
export async function listMessages(contact: Contact): Promise<DispatchMessage[]> {
  return db
    .select()
    .from(dispatchMessages)
    .where(contactFilter(contact))
    .orderBy(asc(dispatchMessages.createdAt));
}

function contactColumns(contact: Contact) {
  return {
    driverId: contact.kind === "DRIVER" ? contact.id : null,
    affiliateId: contact.kind === "AFFILIATE" ? contact.id : null,
  };
}

/**
 * The job, written the way somebody reads it on a phone.
 *
 * New York time, because that is where the car is, and the addresses in full
 * rather than shortened — a driver needs the whole thing, not enough of it to
 * recognise.
 */
export function describeOffer(trip: TripRecord): string {
  const start = DateTime.fromJSDate(trip.pickupAt).setZone(OPERATING_TIME_ZONE);
  const lines = [
    `${start.toFormat("cccc d LLL, h:mm a")} — ${trip.bookedHours}h, ${trip.vehicleClass.toLowerCase()}`,
    `Pick up: ${trip.pickupAddress}`,
    `Drop off: ${trip.dropoffAddress}`,
    `Passenger: ${trip.passengerName}`,
  ];
  if (trip.passengerCount != null) lines.push(`${trip.passengerCount} passengers, ${trip.luggageCount ?? 0} bags`);
  if (trip.flightNumber) lines.push(`Flight ${trip.flightNumber}`);
  return lines.join("\n");
}

export async function sendText(params: {
  contact: Contact;
  body: string;
  direction: "OUT" | "IN";
  actor: Actor;
  tripId?: string | null;
}): Promise<DispatchMessage> {
  await requireContact(params.contact);
  const body = params.body.trim();
  if (!body) throw new OpsError("An empty message is not a message.");

  const [row] = await db
    .insert(dispatchMessages)
    .values({
      ...contactColumns(params.contact),
      tripId: params.tripId ?? null,
      direction: params.direction,
      kind: "TEXT",
      body,
      // Outbound is from the desk. Inbound is somebody at the desk standing in
      // for the contact, and the record says which of the two it was.
      authorUserId: params.direction === "OUT" ? params.actor.userId : null,
      authorName: params.direction === "OUT" ? params.actor.name : null,
      actedByUserId: params.direction === "IN" ? params.actor.userId : null,
      actedByName: params.direction === "IN" ? params.actor.name : null,
    })
    .returning();
  return row;
}

export async function sendOffer(params: {
  contact: Contact;
  tripId: string;
  actor: Actor;
  note?: string | null;
}): Promise<DispatchMessage> {
  await requireContact(params.contact);

  const rows = await selectTrips().where(eq(trips.id, params.tripId)).limit(1);
  if (!rows.length) throw new OpsError(`No trip with id ${params.tripId}.`, 404);
  const trip = toTripRecord(rows[0]);

  if (trip.status === "CANCELLED") {
    throw new OpsError("That trip is cancelled. There is nothing to offer.");
  }

  const note = params.note?.trim();
  const [row] = await db
    .insert(dispatchMessages)
    .values({
      ...contactColumns(params.contact),
      tripId: trip.id,
      direction: "OUT",
      kind: "OFFER",
      body: note ? `${describeOffer(trip)}\n\n${note}` : describeOffer(trip),
      authorUserId: params.actor.userId,
      authorName: params.actor.name,
    })
    .returning();
  return row;
}

/** An offer that has not been answered yet, or null. */
export async function pendingResponse(offerId: string): Promise<DispatchMessage | null> {
  const [row] = await db
    .select()
    .from(dispatchMessages)
    .where(
      and(
        eq(dispatchMessages.respondsToId, offerId),
        or(eq(dispatchMessages.kind, "ACCEPT"), eq(dispatchMessages.kind, "DECLINE"))
      )
    )
    .limit(1);
  return row ?? null;
}

export interface OfferOutcome {
  message: DispatchMessage;
  /** Set when accepting actually assigned somebody. */
  trip: TripRecord | null;
}

/**
 * Accepting or turning down an offer.
 *
 * Accepting assigns the driver before anything is written down. If the desk
 * refuses — they are already out on another job — nothing is recorded at all,
 * because a thread showing an acceptance that never took effect is worse than
 * a thread showing nothing.
 */
export async function respondToOffer(params: {
  offerId: string;
  accept: boolean;
  actor: Actor;
  note?: string | null;
}): Promise<OfferOutcome> {
  const [offer] = await db
    .select()
    .from(dispatchMessages)
    .where(eq(dispatchMessages.id, params.offerId))
    .limit(1);
  if (!offer) throw new OpsError(`No offer with id ${params.offerId}.`, 404);
  if (offer.kind !== "OFFER") throw new OpsError("That message is not an offer.");

  const already = await pendingResponse(offer.id);
  if (already) {
    throw new OpsError(
      `That offer was already ${already.kind === "ACCEPT" ? "accepted" : "declined"}.`,
      409
    );
  }

  let trip: TripRecord | null = null;
  if (params.accept) {
    if (!offer.tripId) throw new OpsError("That offer is not about a job.");
    // Through updateTrip, so the double-booking refusal and the trip's own
    // history apply exactly as they do on the Reservations screen.
    trip = await updateTrip(
      offer.tripId,
      offer.driverId ? { driverId: offer.driverId } : { affiliateId: offer.affiliateId },
      params.actor
    );
  }

  const note = params.note?.trim();
  const [row] = await db
    .insert(dispatchMessages)
    .values({
      tripId: offer.tripId,
      driverId: offer.driverId,
      affiliateId: offer.affiliateId,
      direction: "IN",
      kind: params.accept ? "ACCEPT" : "DECLINE",
      body: note || (params.accept ? "Yes, I can take that." : "Sorry, I can't take that one."),
      respondsToId: offer.id,
      actedByUserId: params.actor.userId,
      actedByName: params.actor.name,
    })
    .returning();

  return { message: row, trip };
}

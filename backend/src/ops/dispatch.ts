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

import { and, asc, desc, eq, isNotNull, isNull, notInArray, or, sql } from "drizzle-orm";
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

async function requireContact(contact: Contact, forWork = false): Promise<string> {
  if (contact.kind === "DRIVER") {
    const [row] = await db.select().from(drivers).where(eq(drivers.id, contact.id)).limit(1);
    if (!row) throw new OpsError(`No driver with id ${contact.id}.`, 404);
    // `updateTrip` refuses to put work on a deactivated driver, so an offer to
    // one could be sent and would then fail at the acceptance — after the
    // driver had been told about a job they cannot take. Refuse it up front.
    if (forWork && !row.active) {
      throw new OpsError(`${row.name} is deactivated and cannot be offered work.`);
    }
    return row.name;
  }
  const [row] = await db.select().from(affiliates).where(eq(affiliates.id, contact.id)).limit(1);
  if (!row) throw new OpsError(`No partner with id ${contact.id}.`, 404);
  if (forWork && !row.active) {
    throw new OpsError(`${row.company} is deactivated and cannot be offered work.`);
  }
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
/** "1 bag", "4 bags", or null when nobody said. Zero is a fact; absent is not. */
function count(n: number | null, noun: string): string | null {
  return n === null ? null : `${n} ${noun}${n === 1 ? "" : "s"}`;
}

export function describeOffer(trip: TripRecord): string {
  const start = DateTime.fromJSDate(trip.pickupAt).setZone(OPERATING_TIME_ZONE);
  const lines = [
    `${start.toFormat("cccc d LLL, h:mm a")} — ${trip.bookedHours}h, ${trip.vehicleClass.toLowerCase()}`,
    `Pick up: ${trip.pickupAddress}`,
    `Drop off: ${trip.dropoffAddress}`,
    `Passenger: ${trip.passengerName}`,
  ];
  // What we know, and — where the other half is missing — that we do not know
  // it. `luggageCount ?? 0` told drivers "0 bags" when nobody had said 0, which
  // is a car arriving too small for the boot it has to fill; and the whole line
  // was skipped when only the bag count was known, losing a real number. A
  // driver reading "4 passengers" and nothing else will assume hand luggage.
  const load = [
    count(trip.passengerCount, "passenger"),
    count(trip.luggageCount, "bag"),
  ];
  if (load.some(Boolean)) {
    lines.push(
      [load[0] ?? "passengers not stated", load[1] ?? "bag count not stated"].join(", ")
    );
  }
  if (trip.flightNumber) lines.push(`Flight ${trip.flightNumber}`);
  // The note belongs here. "Child seat required", "meet and greet", "quiet
  // ride" — every one of them is an instruction for whoever drives, and the
  // desk already treats a change to it as something they must be told. It
  // was flagged as needing telling and then left out of the telling.
  if (trip.notes) lines.push(`Note: ${trip.notes}`);
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
  await requireContact(params.contact, true);

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

/**
 * The accept or decline already sitting against this offer, or null.
 *
 * Named `pendingResponse` and documented as "an offer that has not been
 * answered yet", which is the opposite of what it returns. The caller was
 * always right; the name and the comment were both backwards, which is the
 * kind of thing that reads fine until somebody trusts it at speed.
 */
export async function answerTo(offerId: string): Promise<DispatchMessage | null> {
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
/**
 * The answer, with the race the polite check above cannot close.
 *
 * Two acceptances arriving together both read "not answered yet" and both
 * wrote. The unique index refuses the second; this turns that refusal into the
 * same sentence the check would have used.
 */
async function insertAnswer(
  values: typeof dispatchMessages.$inferInsert
): Promise<DispatchMessage> {
  try {
    const [row] = await db.insert(dispatchMessages).values(values).returning();
    return row;
  } catch (err) {
    for (let e = err as { code?: string; constraint?: string; cause?: unknown } | undefined; e; ) {
      if (e.code === "23505" && e.constraint === "dispatch_one_answer_per_offer") {
        throw new OpsError("That offer has already been answered.", 409);
      }
      e = e.cause as typeof e;
    }
    throw err;
  }
}

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

  const already = await answerTo(offer.id);
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
  } else if (offer.tripId) {
    // Turning down a job you are already on gives it back.
    //
    // Declining used to only record the refusal, which is right for a job
    // that was never theirs. It is wrong for a booking they hold: after a
    // change is re-offered and refused, leaving them assigned means the
    // schedule reads as covered by somebody who has just said no.
    //
    // The car goes with them. A vehicle left attached to an unassigned job
    // still shows as busy on the schedule board, hiding a car that is free.
    const [current] = await db
      .select({ driverId: trips.driverId, affiliateId: trips.affiliateId })
      .from(trips)
      .where(eq(trips.id, offer.tripId))
      .limit(1);
    const holdsIt = offer.driverId
      ? current?.driverId === offer.driverId
      : current?.affiliateId === offer.affiliateId;
    if (holdsIt) {
      trip = await updateTrip(
        offer.tripId,
        offer.driverId ? { driverId: null, vehicleId: null } : { affiliateId: null },
        params.actor
      );
    }
  }

  const note = params.note?.trim();
  const row = await insertAnswer({
    tripId: offer.tripId,
    driverId: offer.driverId,
    affiliateId: offer.affiliateId,
    direction: "IN",
    kind: params.accept ? "ACCEPT" : "DECLINE",
    body: note || (params.accept ? "Yes, I can take that." : "Sorry, I can't take that one."),
    respondsToId: offer.id,
    actedByUserId: params.actor.userId,
    actedByName: params.actor.name,
  });

  return { message: row, trip };
}

/**
 * Everything said to a driver or a partner about this ticket's booking.
 *
 * Dispatch traffic lived only on the Messages screen, which meant a ticket
 * could say "nobody assigned yet" while an offer had already gone out and been
 * accepted — the two halves of the same job, on two screens, neither
 * mentioning the other. Whoever picks the ticket up next needs to see that
 * without knowing to go looking.
 *
 * Joined through the trip rather than the ticket: a dispatch message is about
 * a job, and the job is what the ticket produced.
 */
export interface TicketDispatchEntry {
  id: string;
  at: Date;
  direction: "OUT" | "IN";
  kind: "OFFER" | "ACCEPT" | "DECLINE" | "TEXT";
  body: string;
  contactKind: "DRIVER" | "AFFILIATE";
  contactName: string;
  /** Staff member who sent it, for anything outbound. */
  authorName: string | null;
  /** Who typed an inbound message while standing in for the contact. */
  actedByName: string | null;
}

export async function listDispatchForTrip(tripId: string): Promise<TicketDispatchEntry[]> {
  const rows = await db
    .select({
      id: dispatchMessages.id,
      at: dispatchMessages.createdAt,
      direction: dispatchMessages.direction,
      kind: dispatchMessages.kind,
      body: dispatchMessages.body,
      driverId: dispatchMessages.driverId,
      driverName: drivers.name,
      affiliateId: dispatchMessages.affiliateId,
      affiliateCompany: affiliates.company,
      authorName: dispatchMessages.authorName,
      actedByName: dispatchMessages.actedByName,
    })
    .from(dispatchMessages)
    .leftJoin(drivers, eq(drivers.id, dispatchMessages.driverId))
    .leftJoin(affiliates, eq(affiliates.id, dispatchMessages.affiliateId))
    .where(eq(dispatchMessages.tripId, tripId))
    .orderBy(asc(dispatchMessages.createdAt));

  return rows.map((r) => ({
    id: r.id,
    at: r.at,
    direction: r.direction,
    kind: r.kind,
    body: r.body,
    contactKind: r.driverId ? ("DRIVER" as const) : ("AFFILIATE" as const),
    // A contact deleted after the fact leaves the message behind, and a blank
    // name in a timeline reads as a bug. Say what is known.
    contactName: r.driverName ?? r.affiliateCompany ?? "a contact no longer on file",
    authorName: r.authorName,
    actedByName: r.actedByName,
  }));
}

/**
 * When we last said anything to this contact about this job.
 *
 * Used to answer the only question that matters after a booking moves: does
 * the person driving it know? A trip whose `updatedAt` is later than this has
 * changed since anybody told them.
 */
export async function lastSpokeTo(tripId: string, contact: Contact): Promise<Date | null> {
  const [row] = await db
    .select({ at: dispatchMessages.createdAt })
    .from(dispatchMessages)
    .where(and(eq(dispatchMessages.tripId, tripId), contactFilter(contact)))
    .orderBy(desc(dispatchMessages.createdAt))
    .limit(1);
  return row?.at ?? null;
}

/**
 * Tell whoever has this job that it has changed.
 *
 * The details are rebuilt from the trip by the same function that wrote the
 * original offer, so what they receive is the job as it now stands rather
 * than a description of the edit. Somebody reading it on a phone needs the
 * new time and the new addresses, not a diff.
 *
 * Sent, not queued: a car turning up an hour late because a change sat in a
 * draft is the whole failure this exists to prevent.
 */
export async function sendChangeNotice(params: {
  contact: Contact;
  tripId: string;
  actor: Actor;
  note?: string | null;
}): Promise<DispatchMessage> {
  await requireContact(params.contact, true);

  const rows = await selectTrips().where(eq(trips.id, params.tripId)).limit(1);
  if (!rows.length) throw new OpsError(`No trip with id ${params.tripId}.`, 404);
  const trip = toTripRecord(rows[0]);

  const note = params.note?.trim();
  const body = [
    `${trip.reference} has changed. It now reads:`,
    "",
    describeOffer(trip),
    note ? `\n${note}` : "",
    "",
    "Let us know if you can still cover it.",
  ]
    .filter((line) => line !== null)
    .join("\n");

  const [row] = await db
    .insert(dispatchMessages)
    .values({
      tripId: trip.id,
      ...contactColumns(params.contact),
      direction: "OUT",
      // An OFFER, not a TEXT.
      //
      // It went out as a TEXT first, on the reasoning that the job was
      // already theirs. That produced a message ending "let us know if you
      // can still cover it" with no way to answer it — the driver had been
      // asked a question the screen gave them no means of replying to. The
      // one-answer rule is keyed to the individual offer, so a second offer
      // is answerable on its own.
      kind: "OFFER",
      body,
      authorUserId: params.actor.userId,
      authorName: params.actor.name,
    })
    .returning();
  return row;
}

/**
 * How many offers each contact has been sent and not yet answered.
 *
 * The Messages list gives no sign of who is waiting on you: a dispatcher has
 * to click through fourteen drivers to find the one with a job outstanding.
 * An unanswered offer is the one piece of state on that screen that is
 * genuinely urgent — a car is not yet booked and somebody is expected to say
 * yes or no.
 *
 * "Unanswered" is the absence of a reply pointing back at the offer, which is
 * the same definition `answerTo` uses; asking the database rather than
 * counting in memory keeps the two from drifting apart.
 */
export interface PendingOffers {
  drivers: Record<string, number>;
  affiliates: Record<string, number>;
}

export async function pendingOfferCounts(): Promise<PendingOffers> {
  const answers = db
    .select({ id: dispatchMessages.respondsToId })
    .from(dispatchMessages)
    .where(isNotNull(dispatchMessages.respondsToId));

  const rows = await db
    .select({
      driverId: dispatchMessages.driverId,
      affiliateId: dispatchMessages.affiliateId,
      waiting: sql<number>`count(*)::int`,
    })
    .from(dispatchMessages)
    .where(
      and(
        eq(dispatchMessages.kind, "OFFER"),
        notInArray(dispatchMessages.id, answers)
      )
    )
    .groupBy(dispatchMessages.driverId, dispatchMessages.affiliateId);

  const pending: PendingOffers = { drivers: {}, affiliates: {} };
  for (const row of rows) {
    if (row.driverId) pending.drivers[row.driverId] = row.waiting;
    else if (row.affiliateId) pending.affiliates[row.affiliateId] = row.waiting;
  }
  return pending;
}

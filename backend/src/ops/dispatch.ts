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
import { customerPriceCents, money } from "./margin";

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
  kind: "OFFER" | "ACCEPT" | "DECLINE" | "TEXT" | "QUOTE_REQUEST" | "QUOTE";
  /** Money on a QUOTE, or on the OFFER that awarded the job. */
  amountCents: number | null;
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
      amountCents: dispatchMessages.amountCents,
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
    amountCents: r.amountCents,
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

// ---------------------------------------------------------------------------
// Farming a job out: ask, quote, award, confirm.
//
// A trip that leaves NY/NJ has to be covered by somebody else, and until they
// tell us what they charge we do not know what it costs. That is why the first
// reply to the customer carries no price — see draft.service — and why this
// exists.
//
// Four steps, and the last two are the ordinary offer machinery rather than
// anything new. Asking is a QUOTE_REQUEST to several partners at once, each
// answers with a QUOTE, and accepting one turns into an OFFER naming the money
// agreed. That partner then ACCEPTs, which assigns them the job through
// exactly the same path a driver goes through. There is one way to assign a
// trip, and adding a second would be how two cars turn up.
// ---------------------------------------------------------------------------

/** The reservation as a partner needs to see it, with no price attached. */
export function describeQuoteRequest(trip: TripRecord): string {
  return [
    describeOffer(trip),
    "",
    "We do not need you to hold anything yet — please reply with your price for this job.",
  ].join("\n");
}

/**
 * Send the same job to several partners at once and ask what they charge.
 *
 * Several, because a single partner asked in turn costs a round trip of
 * waiting each time, and an out-of-area job often needs answering the same
 * day. The ones not chosen have to be told afterwards, which is the price of
 * asking in parallel and is a person's job, not this function's.
 *
 * Partly-failed rather than all-or-nothing: a partner who has been
 * deactivated since the panel was drawn should not stop the request reaching
 * the other two. Who it reached comes back, so a screen can say so.
 */
export async function requestQuotes(params: {
  tripId: string;
  affiliateIds: string[];
  actor: Actor;
  note?: string | null;
}): Promise<{ sent: DispatchMessage[]; refused: { affiliateId: string; reason: string }[] }> {
  const rows = await selectTrips().where(eq(trips.id, params.tripId)).limit(1);
  if (!rows.length) throw new OpsError(`No trip with id ${params.tripId}.`, 404);
  const trip = toTripRecord(rows[0]);

  if (trip.status === "CANCELLED") {
    throw new OpsError("That trip is cancelled. There is nothing to quote for.");
  }
  const wanted = [...new Set(params.affiliateIds.filter(Boolean))];
  if (wanted.length === 0) throw new OpsError("Choose at least one partner to ask.");

  const note = params.note?.trim();
  const body = note ? `${describeQuoteRequest(trip)}\n\n${note}` : describeQuoteRequest(trip);

  const sent: DispatchMessage[] = [];
  const refused: { affiliateId: string; reason: string }[] = [];

  for (const affiliateId of wanted) {
    try {
      await requireContact({ kind: "AFFILIATE", id: affiliateId }, true);
      const [row] = await db
        .insert(dispatchMessages)
        .values({
          affiliateId,
          tripId: trip.id,
          direction: "OUT",
          kind: "QUOTE_REQUEST",
          body,
          authorUserId: params.actor.userId,
          authorName: params.actor.name,
        })
        .returning();
      sent.push(row);
    } catch (err) {
      refused.push({
        affiliateId,
        reason: err instanceof OpsError ? err.message : "Could not send that request.",
      });
    }
  }

  return { sent, refused };
}

/**
 * A partner's price, coming back.
 *
 * The amount is required and must be a real number of cents. A quote with no
 * figure is a conversation, and `sendText` already exists for those — letting
 * one in here would put a job in the "quoted" list with nothing to compare.
 */
export async function recordQuote(params: {
  requestId: string;
  amountCents: number;
  actor: Actor;
  note?: string | null;
}): Promise<DispatchMessage> {
  const [request] = await db
    .select()
    .from(dispatchMessages)
    .where(eq(dispatchMessages.id, params.requestId))
    .limit(1);
  if (!request) throw new OpsError(`No quote request with id ${params.requestId}.`, 404);
  if (request.kind !== "QUOTE_REQUEST") {
    throw new OpsError("That message is not a request for a quote.");
  }
  if (!Number.isInteger(params.amountCents) || params.amountCents <= 0) {
    throw new OpsError("A quote needs a price.");
  }

  // One quote per request, for the same reason there is one answer per offer:
  // two prices against one question and nothing says which we agreed to.
  //
  // Deliberately not `answerTo`, which looks only for an ACCEPT or a DECLINE.
  // Widening that would make it report an unanswered offer as answered, and
  // `respondToOffer` refuses on exactly that. The database's one-answer index
  // catches this either way — it did, the first time this was written — but a
  // raw constraint violation is not something to put in front of a person.
  const already = await quoteTo(request.id);
  if (already) {
    throw new OpsError(
      `That partner has already quoted ${money(already.amountCents ?? 0)}. Ask again if the price has changed.`,
      409
    );
  }

  const note = params.note?.trim();
  const [row] = await db
    .insert(dispatchMessages)
    .values({
      affiliateId: request.affiliateId,
      driverId: request.driverId,
      tripId: request.tripId,
      direction: "IN",
      kind: "QUOTE",
      body: note ? `${money(params.amountCents)} — ${note}` : money(params.amountCents),
      amountCents: params.amountCents,
      respondsToId: request.id,
      // Inbound: somebody at the desk standing in for the partner until
      // partners have links of their own. The record says who typed it.
      actedByUserId: params.actor.userId,
      actedByName: params.actor.name,
    })
    .returning();
  return row;
}

/** The price already given against a request, or null. */
export async function quoteTo(requestId: string): Promise<DispatchMessage | null> {
  const [row] = await db
    .select()
    .from(dispatchMessages)
    .where(
      and(eq(dispatchMessages.respondsToId, requestId), eq(dispatchMessages.kind, "QUOTE"))
    )
    .limit(1);
  return row ?? null;
}

export interface PartnerQuote {
  requestId: string;
  quoteId: string | null;
  affiliateId: string;
  company: string;
  askedAt: Date;
  quotedAt: Date | null;
  amountCents: number | null;
  /** What we would charge the customer for it, margin included. */
  customerCents: number | null;
  /** True once this quote has been turned into an offer. */
  awarded: boolean;
}

/** Every partner asked about this job, and what they said. */
export async function quotesForTrip(tripId: string): Promise<PartnerQuote[]> {
  const rows = await db
    .select({
      id: dispatchMessages.id,
      kind: dispatchMessages.kind,
      affiliateId: dispatchMessages.affiliateId,
      company: affiliates.company,
      createdAt: dispatchMessages.createdAt,
      amountCents: dispatchMessages.amountCents,
      respondsToId: dispatchMessages.respondsToId,
    })
    .from(dispatchMessages)
    .leftJoin(affiliates, eq(affiliates.id, dispatchMessages.affiliateId))
    .where(eq(dispatchMessages.tripId, tripId))
    .orderBy(asc(dispatchMessages.createdAt));

  const quotes = new Map<string, (typeof rows)[number]>();
  for (const r of rows) if (r.kind === "QUOTE" && r.respondsToId) quotes.set(r.respondsToId, r);

  // An awarded quote is one whose partner has since been sent an offer. Read
  // off the messages rather than kept as a flag, so it cannot drift from what
  // actually happened.
  const offered = new Set(
    rows.filter((r) => r.kind === "OFFER" && r.affiliateId).map((r) => r.affiliateId as string)
  );

  return rows
    .filter((r) => r.kind === "QUOTE_REQUEST" && r.affiliateId)
    .map((request) => {
      const quote = quotes.get(request.id) ?? null;
      return {
        requestId: request.id,
        quoteId: quote?.id ?? null,
        affiliateId: request.affiliateId as string,
        company: request.company ?? "a partner no longer on file",
        askedAt: request.createdAt,
        quotedAt: quote?.createdAt ?? null,
        amountCents: quote?.amountCents ?? null,
        customerCents:
          typeof quote?.amountCents === "number" ? customerPriceCents(quote.amountCents) : null,
        awarded: Boolean(quote) && offered.has(request.affiliateId as string),
      };
    });
}

/**
 * Take one partner's quote, and offer them the job at that price.
 *
 * The money is written onto the trip here rather than left to be read back off
 * the message. A partner can quote the same job twice — a price rises, we ask
 * again — and an invoice six weeks later has to say which one we took.
 *
 * The customer's price is stored too, not recomputed. The margin is a setting,
 * settings change, and a figure a customer has been given must not move
 * because somebody edited a percentage afterwards.
 *
 * This does NOT assign the partner. They still have to accept, through the
 * same path a driver does, because a quote given on Tuesday is not a promise
 * that the car is still free on Thursday.
 */
export async function awardQuote(params: {
  quoteId: string;
  actor: Actor;
  note?: string | null;
}): Promise<{ offer: DispatchMessage; trip: TripRecord }> {
  const [quote] = await db
    .select()
    .from(dispatchMessages)
    .where(eq(dispatchMessages.id, params.quoteId))
    .limit(1);
  if (!quote) throw new OpsError(`No quote with id ${params.quoteId}.`, 404);
  if (quote.kind !== "QUOTE") throw new OpsError("That message is not a quote.");
  if (!quote.tripId || !quote.affiliateId || typeof quote.amountCents !== "number") {
    throw new OpsError("That quote is not a priced offer for a job.");
  }

  const rows = await selectTrips().where(eq(trips.id, quote.tripId)).limit(1);
  if (!rows.length) throw new OpsError("That job no longer exists.", 404);
  const trip = toTripRecord(rows[0]);
  if (trip.status === "CANCELLED") {
    throw new OpsError("That trip is cancelled. There is nothing to award.");
  }
  if (trip.affiliateId && trip.affiliateId !== quote.affiliateId) {
    throw new OpsError(
      `${trip.reference} is already with ${trip.affiliate?.company ?? "another partner"}. Take it off them before awarding it elsewhere.`,
      409
    );
  }

  return commitPrice({
    trip,
    affiliateId: quote.affiliateId,
    amountCents: quote.amountCents,
    opening: `Confirming ${trip.reference} to you at ${money(quote.amountCents)}, as quoted.`,
    actor: params.actor,
    note: params.note,
  });
}

/**
 * Offer a job to a partner at an agreed price, and write both sides of the
 * money onto it.
 *
 * The one place a farmed-out trip learns what it costs and what it earns.
 * Shared because there are two ways to reach an agreed price and only one of
 * them used to record it: a partner quoting, and a rate card we already hold.
 * The straight offer took the second path and wrote down nothing, so a job
 * could be covered, accepted and confirmed to a customer with no record of
 * what it cost us or what we charged.
 */
async function commitPrice(params: {
  trip: TripRecord;
  affiliateId: string;
  amountCents: number;
  /** The first line, which says where the price came from. */
  opening: string;
  actor: Actor;
  note?: string | null;
}): Promise<{ offer: DispatchMessage; trip: TripRecord }> {
  const customerCents = customerPriceCents(params.amountCents);
  const note = params.note?.trim();

  const body = [
    params.opening,
    "",
    describeOffer(params.trip),
    "",
    "Please accept to confirm you still have the car.",
    ...(note ? ["", note] : []),
  ].join("\n");

  return db.transaction(async (tx) => {
    const [offer] = await tx
      .insert(dispatchMessages)
      .values({
        affiliateId: params.affiliateId,
        tripId: params.trip.id,
        direction: "OUT",
        kind: "OFFER",
        body,
        amountCents: params.amountCents,
        authorUserId: params.actor.userId,
        authorName: params.actor.name,
      })
      .returning();

    await tx
      .update(trips)
      .set({
        partnerQuoteCents: params.amountCents,
        customerPriceCents: customerCents,
        updatedAt: new Date(),
      })
      .where(eq(trips.id, params.trip.id));

    const found = await selectTrips(tx).where(eq(trips.id, params.trip.id)).limit(1);
    return { offer, trip: toTripRecord(found[0]) };
  });
}

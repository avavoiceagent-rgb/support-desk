// What the desk already knows about the ticket in front of you.
//
// Read-only, staff-facing, and computed on request. Nothing here is stored:
// a saved copy would be right at the moment it was written and wrong as soon
// as a trip moved, and the whole point of the ops tables is that availability
// and bookings are derived, never cached.
//
// Nothing here reaches a customer either. This answers "have we seen this
// person before, and is the booking they mention ours?" for a human reading
// the ticket. Putting any of it in a draft is a separate decision that has not
// been made yet, deliberately — the lookups have not been watched against real
// email long enough to make claims in front of a customer.

import { and, asc, eq } from "drizzle-orm";
import { db } from "../db/client";
import { messages, tickets } from "../db/schema";
import { toPlainText } from "../ai/classifier";
import { extractReferences } from "../ops/references";
import {
  findInvoiceByReference,
  findTripByReference,
  findTripsForEmail,
  type InvoiceRecord,
  type TripRecord,
} from "../ops/lookup";

/**
 * Why a record is on this list. The distinction matters to whoever reads it:
 * "they named this booking" is evidence, "this is the last thing they booked"
 * is a guess that happens to be useful.
 */
export type OpsContextReason = "QUOTED_IN_EMAIL" | "SENDER_RECENT" | "SENDER_UPCOMING";

export interface OpsContextTrip {
  reason: OpsContextReason;
  trip: TripRecord;
}

export interface OpsContextInvoice {
  reason: OpsContextReason;
  invoice: InvoiceRecord;
}

export interface OpsContext {
  ticketId: string;
  /** The address the sender history was matched on, or null if we have none. */
  senderEmail: string | null;
  /** Canonical references found in the email, whether or not they resolved. */
  quotedReferences: { trips: string[]; invoices: string[] };
  /**
   * References the customer quoted that match nothing on file. Worth showing:
   * somebody quoting a booking we cannot find is either mistyping or talking
   * about another company, and both are things a person should notice.
   */
  unresolvedReferences: string[];
  trips: OpsContextTrip[];
  invoices: OpsContextInvoice[];
}

/**
 * Everything on file for a ticket, or null when there is no such ticket.
 *
 * Quoted references come first and win any tie: if a trip is both named in the
 * email and the sender's most recent booking, it is listed once, as quoted.
 */
export async function getOpsContext(ticketId: string): Promise<OpsContext | null> {
  const [ticket] = await db.select().from(tickets).where(eq(tickets.id, ticketId)).limit(1);
  if (!ticket) return null;

  // The first inbound message is what the customer actually wrote; later ones
  // may be our own replies quoted back, which would find our own references.
  const [firstInbound] = await db
    .select({
      subject: messages.subject,
      bodyHtml: messages.bodyHtml,
      bodyText: messages.bodyText,
    })
    .from(messages)
    .where(and(eq(messages.ticketId, ticketId), eq(messages.direction, "INBOUND")))
    .orderBy(asc(messages.sentAt))
    .limit(1);

  const quoted = firstInbound
    ? extractReferences(firstInbound.subject, toPlainText(firstInbound.bodyHtml, firstInbound.bodyText))
    : { trips: [], invoices: [] };

  // `requesterEmail` is the parsed address; `messages.fromAddress` is the raw
  // header and can carry a display name, so it is the wrong thing to match on.
  const senderEmail = ticket.requesterEmail;

  const [quotedTrips, quotedInvoices, recent, upcoming] = await Promise.all([
    Promise.all(quoted.trips.map((ref) => findTripByReference(ref))),
    Promise.all(quoted.invoices.map((ref) => findInvoiceByReference(ref))),
    senderEmail ? findTripsForEmail(senderEmail) : Promise.resolve([]),
    senderEmail ? findTripsForEmail(senderEmail, { upcoming: true }) : Promise.resolve([]),
  ]);

  const unresolvedReferences = [
    ...quoted.trips.filter((_, i) => quotedTrips[i] === null),
    ...quoted.invoices.filter((_, i) => quotedInvoices[i] === null),
  ];

  const trips: OpsContextTrip[] = [];
  const seenTrips = new Set<string>();
  const addTrip = (trip: TripRecord, reason: OpsContextReason) => {
    if (seenTrips.has(trip.id)) return;
    seenTrips.add(trip.id);
    trips.push({ reason, trip });
  };

  for (const trip of quotedTrips) if (trip) addTrip(trip, "QUOTED_IN_EMAIL");
  for (const trip of upcoming) addTrip(trip, "SENDER_UPCOMING");
  for (const trip of recent) addTrip(trip, "SENDER_RECENT");

  const invoices: OpsContextInvoice[] = [];
  for (const invoice of quotedInvoices) {
    if (invoice) invoices.push({ reason: "QUOTED_IN_EMAIL", invoice });
  }

  return {
    ticketId,
    senderEmail,
    quotedReferences: quoted,
    unresolvedReferences,
    trips,
    invoices,
  };
}

// Producing a draft reply for a new reservation ticket.
//
// The order matters: pull the facts out of the email, check the addresses
// against a map, measure the drive, do the timing arithmetic in code, decide
// what still needs asking by rule — and only then ask a model to write it up.
// Every number in the finished email traces back to something checked.
//
// Like triage, this never blocks mail and never throws at the call site.

import { and, asc, eq } from "drizzle-orm";
import { db } from "../db/client";
import { tickets, messages, ticketDrafts, users } from "../db/schema";
import { vehicleClassFor } from "../booking/vehicles";
import { isClassificationEnabled } from "../ai/classifier";
import { extractBooking } from "../booking/extract";
import { verifyAddress, estimateRoute, isMapsEnabled, resolveServiceArea } from "../booking/maps";
import type { VerifiedAddress } from "../booking/maps";
import { planPickup } from "../booking/pickup-time";
import { reviewBooking } from "../booking/questions";
import { lookupIndicativeRate } from "../booking/rates";
import { composeReply } from "../booking/compose";
import { toPlainText } from "../ai/classifier";
import { SERVICE_AREA_STATES } from "../types";
import { DateTime } from "luxon";
import { OPERATING_TIME_ZONE } from "../booking/pickup-time";
import { emailFromHeader } from "../mail/address";
import { stripQuotedReply } from "../mail/quoted";
import { mergeFacts, describeFactChanges } from "../booking/facts";

/** Filled in with the name of whoever opens the draft. */
export const AGENT_NAME_PLACEHOLDER = "{{AGENT_NAME}}";

function nameFromAddress(from: string): string | null {
  const match = from.match(/^(.*?)</);
  const name = match?.[1]?.trim().replace(/^"|"$/g, "");
  return name || null;
}

/**
 * Draft a reply for one ticket. Returns true when a draft was stored.
 *
 * Only new reservations, and only while nobody has replied yet — the moment a
 * person writes to the customer themselves, a machine-written first reply is
 * worse than none.
 */
export async function draftReplyForTicket(ticketId: string): Promise<boolean> {
  if (!isClassificationEnabled()) return false;

  try {
    const ticket = await db.query.tickets.findFirst({ where: eq(tickets.id, ticketId) });
    if (!ticket) return false;
    if (ticket.isBulk) return false;
    if (ticket.queue !== "RESERVATION" || ticket.reservationType !== "NEW") return false;

    const existing = await db.query.ticketDrafts.findFirst({
      where: eq(ticketDrafts.ticketId, ticketId),
    });
    if (existing) return false;

    const conversation = await db
      .select({
        direction: messages.direction,
        subject: messages.subject,
        bodyHtml: messages.bodyHtml,
        bodyText: messages.bodyText,
        fromAddress: messages.fromAddress,
        sentAt: messages.sentAt,
      })
      .from(messages)
      .where(eq(messages.ticketId, ticketId))
      .orderBy(asc(messages.sentAt));

    // Somebody has already answered; leave it to them.
    if (conversation.some((m) => m.direction === "OUTBOUND")) return false;

    const first = conversation[0];
    if (!first) return false;

    // --- 1. What did the email actually say? -----------------------------
    const booking = await extractBooking({
      subject: first.subject,
      body: toPlainText(first.bodyHtml, first.bodyText),
      fromAddress: first.fromAddress,
      receivedAt: first.sentAt,
    });
    if (!booking) return false;

    // --- 2. Check the places against a map -------------------------------
    const [pickup, dropoff] = await Promise.all([
      booking.pickupAddressText ? verifyAddress(booking.pickupAddressText) : Promise.resolve(null),
      booking.dropoffAddressText ? verifyAddress(booking.dropoffAddressText) : Promise.resolve(null),
    ]);
    const stops: (VerifiedAddress | null)[] = [];
    for (const stop of booking.stops) {
      stops.push(await verifyAddress(stop.addressText));
    }

    // --- 3. How long does the drive actually take? -----------------------
    let driveMinutes: number | null = null;
    let miles: number | null = null;
    if (pickup && dropoff) {
      const departAt = booking.requestedPickupLocal
        ? DateTime.fromISO(booking.requestedPickupLocal, { zone: OPERATING_TIME_ZONE }).toJSDate()
        : null;
      const route = await estimateRoute({
        originPlaceId: pickup.placeId,
        destinationPlaceId: dropoff.placeId,
        viaPlaceIds: stops.filter((s): s is VerifiedAddress => s !== null).map((s) => s.placeId),
        departureTime: departAt,
      });
      driveMinutes = route?.minutes ?? null;
      miles = route?.miles ?? null;
    }

    // --- 4. Timing, in code ----------------------------------------------
    const goingToAirport = booking.flightDirection === "DEPARTURE" || Boolean(dropoff?.isAirport);
    const plan = planPickup({
      requestedPickupLocal: booking.requestedPickupLocal,
      flightDepartsLocal: goingToAirport ? booking.flightTimeLocal : null,
      flightKind: goingToAirport ? booking.flightKind : null,
      driveMinutes,
      stopDurationsMinutes: booking.stops.map((s) => s.durationMinutes),
    });

    // --- 5. Is this ours to run? -----------------------------------------
    // Decided from the geocoded state codes, not from the model's reading of
    // the email. Triage labels this before any address has been checked, and
    // it got Manhattan-to-JFK wrong, so a verified answer overrides it —
    // unless a person has already set the label themselves.
    const geocodedSource = resolveServiceArea([pickup, ...stops, dropoff], SERVICE_AREA_STATES);
    if (geocodedSource && ticket.autoClassified && geocodedSource !== ticket.reservationSource) {
      await db
        .update(tickets)
        .set({ reservationSource: geocodedSource })
        .where(and(eq(tickets.id, ticketId), eq(tickets.autoClassified, true)));
    }

    // --- 6. What do we confirm, what do we ask? --------------------------
    const isExternal =
      (geocodedSource ?? ticket.reservationSource) === "EXTERNAL";
    const review = reviewBooking({
      booking,
      pickup,
      dropoff,
      stops,
      plan,
      isExternal,
      senderEmail: ticket.requesterEmail ?? first.fromAddress,
    });

    // --- 7. A rough market price, only when we know both ends ------------
    const rate =
      pickup && dropoff
        ? await lookupIndicativeRate({
            pickupDescription: pickup.formattedAddress,
            dropoffDescription: dropoff.formattedAddress,
            miles,
            vehicle: review.vehicleSuggestion,
          })
        : null;

    // --- 8. Write it -----------------------------------------------------
    const composed = await composeReply({
      review,
      plan,
      rate,
      // The name the person SIGNED with beats the mailbox's display name:
      // bookers routinely write from a shared or company address, so the two
      // are often different people.
      customerName:
        booking.bookerName ?? ticket.requesterName ?? nameFromAddress(first.fromAddress),
      isExternal,
      agentName: AGENT_NAME_PLACEHOLDER,
    });
    if (!composed) return false;

    // Guard against two polls racing on the same ticket.
    const [written] = await db
      .insert(ticketDrafts)
      .values({
        ticketId,
        bodyHtml: composed.bodyHtml,
        confirmations: review.confirmations,
        questions: review.questions,
        internalNotes: review.internalNotes,
        rate: rate ?? null,
        // Kept so an agreed booking can become a reservation without anybody
        // reading the English back or asking the model a second time. The
        // addresses are the geocoded ones and the pickup is the time we
        // recommended, because those are the values in the email the customer
        // received.
        facts: {
          passengerName:
            booking.passengerName ?? (booking.bookerIsPassenger ? booking.bookerName : null),
          passengerPhone:
            booking.passengerPhone ??
            (booking.useBookerPhoneForPassenger ? booking.bookerPhone : null),
          bookerName: booking.bookerName ?? ticket.requesterName ?? null,
          // Parsed, never the raw header. `booker_email` is matched with
          // `lower(...) = ...` when a customer's history is looked up, so
          // storing "Ana Costa <ana@…>" means those trips never surface for
          // that customer again. Null when it cannot be parsed: not knowing is
          // recoverable, a wrong key is not.
          bookerEmail: ticket.requesterEmail ?? emailFromHeader(first.fromAddress),
          pickupAddress: pickup?.formattedAddress ?? booking.pickupAddressText,
          dropoffAddress: dropoff?.formattedAddress ?? booking.dropoffAddressText,
          // The coordinates behind those addresses, so a partner quote can be
          // measured later without geocoding the same place twice.
          pickupLat: pickup?.lat ?? null,
          pickupLng: pickup?.lng ?? null,
          dropoffLat: dropoff?.lat ?? null,
          dropoffLng: dropoff?.lng ?? null,
          pickupState: pickup?.state ?? null,
          dropoffState: dropoff?.state ?? null,
          stops: stops
            .map((stop, i) => stop?.formattedAddress ?? booking.stops[i]?.addressText ?? null)
            .filter((a): a is string => Boolean(a)),
          // The earlier of the two when the flight kind is still open.
          //
          // A blank here is what left a reservation form empty and let the
          // browser fill it with the current time — a car booked for 7:48am
          // against a 5:45pm flight, offered to a driver, and accepted. The
          // international time is the earlier one, so taking it is the same
          // instinct as rounding a pickup down: early costs a wait, late
          // costs the flight. The internal note says both.
          pickupAtLocal:
            plan.recommendedPickupLocal ??
            booking.requestedPickupLocal ??
            plan.ifInternationalLocal,
          // From the counts, with what they asked for as a floor. Reading the
          // class out of the model's own sentence made "an SUV or a van" a VAN
          // by regex ordering, and asked a model for something already
          // computable from two numbers we had extracted.
          vehicleClass: vehicleClassFor({
            passengerCount: booking.passengerCount,
            luggageCount: booking.luggageCount,
            requested: booking.vehicleRequested ?? review.vehicleSuggestion,
          }),
          passengerCount: booking.passengerCount,
          luggageCount: booking.luggageCount,
          flightNumber: booking.flightNumber,
          flightTimeLocal: booking.flightTimeLocal,
          flightKind: booking.flightKind,
        },
        status: "READY",
      })
      .onConflictDoNothing({ target: ticketDrafts.ticketId })
      .returning({ id: ticketDrafts.id });

    return Boolean(written);
  } catch (err) {
    console.error(`[draft] could not draft a reply for ticket ${ticketId}:`, err);
    return false;
  }
}

/**
 * The draft as a named person should see it. The sign-off is filled in with
 * the name of whoever is looking, because they are the one who will send it.
 *
 * Returned whatever its status: a draft is part of the ticket's history, not a
 * one-time offer. Hiding it once it had been used or dismissed meant a ticket
 * that HAD a draft looked identical to one that never did, and loading it into
 * the composer then navigating away lost it for good.
 */
export async function getDraftForTicket(ticketId: string, userId: string) {
  const draft = await db.query.ticketDrafts.findFirst({
    where: eq(ticketDrafts.ticketId, ticketId),
  });
  if (!draft) return null;

  const [user] = await db.select({ name: users.name }).from(users).where(eq(users.id, userId)).limit(1);
  const agentName = user?.name ?? "";

  return {
    id: draft.id,
    bodyHtml: draft.bodyHtml.split(AGENT_NAME_PLACEHOLDER).join(agentName),
    confirmations: draft.confirmations,
    questions: draft.questions,
    internalNotes: draft.internalNotes,
    rate: draft.rate,
    status: draft.status,
    createdAt: draft.createdAt,
  };
}

export async function setDraftStatus(ticketId: string, status: "USED" | "DISMISSED") {
  await db
    .update(ticketDrafts)
    .set({ status, updatedAt: new Date() })
    .where(eq(ticketDrafts.ticketId, ticketId));
}

/** Maps being unavailable is worth saying out loud once, not per ticket. */
export function warnIfMapsMissing(): void {
  if (isClassificationEnabled() && !isMapsEnabled()) {
    console.warn(
      "[draft] GOOGLE_MAPS_API_KEY is not set: drafts will quote addresses back unverified and cannot suggest a pickup time."
    );
  }
}

/**
 * Re-read a conversation after the customer answers, and keep what is new.
 *
 * The facts behind a booking used to come from the first email and stop
 * there. On ticket #72 the customer replied with a phone number and "the
 * flight is international" — both on the screen, neither on the booking, and
 * the reservation form still opened without them.
 *
 * Deliberately narrow. It reads the customer's own words with our quoted
 * draft stripped out, merges rather than replaces so silence erases nothing,
 * and touches only the stored facts. It does NOT rewrite the drafted reply:
 * that has been read, edited and often already sent, and rewriting it under
 * somebody would be worse than the problem.
 *
 * Never throws at the call site — mail must keep flowing.
 */
export async function refreshFactsFromReply(ticketId: string): Promise<string[]> {
  if (!isClassificationEnabled()) return [];

  try {
    const ticket = await db.query.tickets.findFirst({ where: eq(tickets.id, ticketId) });
    if (!ticket || ticket.queue !== "RESERVATION") return [];

    const draft = await db.query.ticketDrafts.findFirst({
      where: eq(ticketDrafts.ticketId, ticketId),
    });
    // No facts yet means no draft was ever made for this ticket; there is
    // nothing to keep current, and building some here would be a new draft by
    // the back door.
    if (!draft?.facts) return [];

    const inbound = await db
      .select({
        subject: messages.subject,
        bodyHtml: messages.bodyHtml,
        bodyText: messages.bodyText,
        fromAddress: messages.fromAddress,
        sentAt: messages.sentAt,
      })
      .from(messages)
      .where(and(eq(messages.ticketId, ticketId), eq(messages.direction, "INBOUND")))
      .orderBy(asc(messages.sentAt));

    const latest = inbound[inbound.length - 1];
    // Only worth doing once a reply exists: the first email is what the
    // stored facts already came from.
    if (!latest || inbound.length < 2) return [];

    const said = stripQuotedReply(toPlainText(latest.bodyHtml, latest.bodyText));
    if (!said) return [];

    const booking = await extractBooking({
      subject: latest.subject,
      body: said,
      fromAddress: latest.fromAddress,
      receivedAt: latest.sentAt,
    });
    if (!booking) return [];

    const before = draft.facts;
    const after = mergeFacts(before, {
      passengerName: booking.passengerName,
      passengerPhone: booking.passengerPhone ?? booking.bookerPhone,
      bookerName: booking.bookerName,
      passengerCount: booking.passengerCount,
      luggageCount: booking.luggageCount,
      flightNumber: booking.flightNumber,
      flightTimeLocal: booking.flightTimeLocal,
      flightKind: booking.flightKind,
    });

    const changes = describeFactChanges(before, after);
    if (changes.length === 0) return [];

    await db
      .update(ticketDrafts)
      .set({ facts: after, updatedAt: new Date() })
      .where(eq(ticketDrafts.ticketId, ticketId));

    return changes;
  } catch (err) {
    console.error("[draft] could not re-read the reply:", err);
    return [];
  }
}

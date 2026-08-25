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
import { tickets, messages, ticketDrafts, users, type DraftFacts } from "../db/schema";
import { vehicleClassFor } from "../booking/vehicles";
import { isClassificationEnabled } from "../ai/classifier";
import { extractBooking } from "../booking/extract";
import { verifyAddress, estimateRoute, isMapsEnabled, resolveServiceArea } from "../booking/maps";
import type { VerifiedAddress } from "../booking/maps";
import { planPickup } from "../booking/pickup-time";
import { reviewBooking } from "../booking/questions";
import { lookupIndicativeRate, describeRate } from "../booking/rates";
import { composeReply } from "../booking/compose";
import { toPlainText } from "../ai/classifier";
import { SERVICE_AREA_STATES } from "../types";
import { DateTime } from "luxon";
import { OPERATING_TIME_ZONE } from "../booking/pickup-time";
import { emailFromHeader } from "../mail/address";
import { stripQuotedReply } from "../mail/quoted";
import { mergeFacts, describeFactChanges } from "../booking/facts";
import { implausible } from "../booking/plausible";
import { bookingUpdateFrom } from "../booking/booking-update";
import { reservationForTicket } from "../ops/reservations";
import { updateTrip } from "../ops/trips";
import { addDeskNote } from "./note.service";

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
    // The mirror of it: they are being collected off a plane rather than put
    // on one, and the pickup is the landing time rather than something worked
    // back from a deadline.
    const comingFromAirport =
      booking.flightDirection === "ARRIVAL" || (!goingToAirport && Boolean(pickup?.isAirport));
    const plan = planPickup({
      requestedPickupLocal: booking.requestedPickupLocal,
      flightDepartsLocal: goingToAirport ? booking.flightTimeLocal : null,
      flightArrivesLocal: comingFromAirport ? booking.flightTimeLocal : null,
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

    // --- 5b. Does any of this make sense? --------------------------------
    //
    // The one check that is about the answer rather than the question. A
    // customer typed "JFK", Google returned John F. Kennedy in Oklahoma City
    // and did not flag it as a guess, the drive measured 1,341 minutes, the
    // pickup landed the day before the flight, and every word of it was
    // emailed to them. Nothing was broken — each step did exactly what it was
    // told with what it was given, and nowhere asked whether the result was
    // believable.
    //
    // So when it is not, nothing is drafted at all. The desk cannot say
    // anything trustworthy about this trip until somebody looks at the
    // address, and a draft with the good parts kept would put that address in
    // front of a customer under a covering sentence. The ticket gets a note
    // naming what looked wrong, and waits for a person.
    const suggestedPickupLocal =
      plan.recommendedPickupLocal ?? booking.requestedPickupLocal ?? plan.ifInternationalLocal;
    const doubts = implausible({
      driveMinutes,
      dropoffDescription: dropoff?.formattedAddress ?? booking.dropoffAddressText,
      pickupAtLocal: suggestedPickupLocal,
      flightAtLocal: goingToAirport ? booking.flightTimeLocal : null,
    });
    if (doubts.length > 0) {
      await addDeskNote(
        ticketId,
        `Adam has not written a reply for this one, because the numbers do not add up:\n` +
          doubts.map((d) => `• ${d}`).join("\n") +
          `\n\nThe customer wrote "${booking.dropoffAddressText ?? "no drop-off"}" as the drop-off` +
          (dropoff ? ` and the map answered "${dropoff.formattedAddress}"` : "") +
          `. Correct it and reply by hand.`
      );
      return false;
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
    //
    // A partner-covered job carries no price in the first reply.
    //
    // We do not know what this costs yet. A partner has not been asked, let
    // alone quoted, and a market range printed under "we're checking
    // availability" reads to a customer as our number — they remember $125 to
    // $185 and hear the real figure as a rise. The range is still useful, but
    // to the desk, for judging whether a partner's quote is sane. So it goes
    // in the internal notes and nowhere near the email.
    const composed = await composeReply({
      review,
      plan,
      rate: isExternal ? null : rate,
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
        internalNotes: [
          ...review.internalNotes,
          // The draft named an address nobody gave it. Three drafts have now
          // asked a customer whether their email is a phone number, and two
          // fixes aimed at the model did not stop it — so the output is
          // checked and a person is told, rather than hoped at again.
          ...(composed.strayEmails?.length
            ? [
                `Adam wrote ${composed.strayEmails.join(", ")} into the reply, and that address was not in anything he was given. Read that line before sending.`,
              ]
            : []),
          // Held back from the customer, given to you: it is the only
          // reference point you have when a partner quotes.
          ...(isExternal && describeRate(rate)
            ? [
                `This one goes out to a partner, so the reply quotes no price. For your own use, the market range is ${describeRate(rate)}`,
              ]
            : []),
        ],
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
          // The same expression the plausibility check read, not a second
          // copy of it: two places working out "the time we suggest" is two
          // places that can come to disagree.
          pickupAtLocal: suggestedPickupLocal,
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
          // Whether the flight is a deadline or a starting gun. Everything
          // that reads a time off this booking later needs to know which.
          flightDirection: booking.flightDirection,
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
      flightDirection: booking.flightDirection,
      // The time the customer names when they answer.
      //
      // Left out, and it was the one thing a reply most often carries: Adam
      // asks when they would like to be collected, they say, and the answer
      // went into the conversation and nowhere else — so the reservation form
      // still opened with an empty date box, which is exactly the blank that
      // once let a browser fill it with the current time.
      pickupAtLocal: booking.requestedPickupLocal,
    });

    const changes = describeFactChanges(before, after);
    if (changes.length === 0) return [];

    await db
      .update(ticketDrafts)
      .set({ facts: after, updatedAt: new Date() })
      .where(eq(ticketDrafts.ticketId, ticketId));

    // Notes kept current are not the point. The booking is what a car runs
    // on, and until this existed a reply that said "it's international"
    // updated a set of notes and left the pickup an hour too late.
    await carryOntoBooking(ticketId, after, changes);

    return changes;
  } catch (err) {
    console.error("[draft] could not re-read the reply:", err);
    return [];
  }
}

/**
 * Put what the reply established onto the booking, and say so on the ticket.
 *
 * Both halves matter. The change is what keeps the car right; the note is what
 * lets a person see it happened, because the alternative — which is what this
 * did for a day — was a line in a server log Amar will never read, and a
 * pickup time that had quietly moved with nothing on the screen to say why.
 *
 * Never throws. The facts are already saved by the time this runs, and losing
 * them because a trip could not be updated would be the worse trade.
 */
/** Exported for tests; called only from `refreshFactsFromReply`. */
export async function carryOntoBooking(
  ticketId: string,
  facts: DraftFacts,
  changes: string[]
): Promise<void> {
  try {
    const trip = await reservationForTicket(ticketId);

    // No booking yet is the ordinary case, and the happy one: the form is
    // filled from these facts when somebody presses Create, so the reply has
    // already done its work. The note still goes on the ticket.
    if (!trip) {
      await addDeskNote(
        ticketId,
        `Adam re-read the customer's reply and updated the booking details:\n` +
          changes.map((c) => `• ${c}`).join("\n") +
          `\n\nNo reservation has been created from this ticket yet — these are what the form will be filled with.`
      );
      return;
    }

    const update = bookingUpdateFrom(
      {
        pickupAt: trip.pickupAt,
        flightAt: trip.flightAt,
        flightKind: (trip.flightKind as "DOMESTIC" | "INTERNATIONAL" | null) ?? null,
        flightNumber: trip.flightNumber,
        passengerPhone: trip.passengerPhone,
        passengerCount: trip.passengerCount,
        luggageCount: trip.luggageCount,
        status: trip.status,
      },
      {
        flightTimeLocal: facts.flightTimeLocal,
        flightKind: facts.flightKind,
        flightNumber: facts.flightNumber,
        passengerPhone: facts.passengerPhone,
        passengerCount: facts.passengerCount,
        luggageCount: facts.luggageCount,
      }
    );

    const lines: string[] = [];
    if (Object.keys(update.patch).length > 0) {
      // Through the same door the screens use, so the double-booking refusal
      // and the trip's own history apply exactly as they would to a change a
      // person made by hand.
      await updateTrip(trip.id, update.patch, { userId: null, name: "Adam" });
      lines.push(`Adam re-read the customer's reply and updated ${trip.reference}:`);
      lines.push(...update.said.map((s) => `• ${s}`));
    } else {
      lines.push(`Adam re-read the customer's reply. ${trip.reference} already matched:`);
      lines.push(...changes.map((c) => `• ${c}`));
    }

    if (update.needsAPerson.length) {
      lines.push("", "Worth a look:");
      lines.push(...update.needsAPerson.map((s) => `• ${s}`));
    }

    // Whoever is holding the job was told the old times. The offer panel
    // already notices a booking that has moved since the last message — this
    // is the plain-English version of the same fact, where the reader is.
    if (update.patch.pickupAt && (trip.driver || trip.affiliate)) {
      lines.push(
        "",
        `${trip.driver?.name ?? trip.affiliate?.company} is on this job and was told the old time. Send them the change.`
      );
    }

    await addDeskNote(ticketId, lines.join("\n"));
  } catch (err) {
    console.error("[draft] could not carry the reply onto the booking:", err);
  }
}

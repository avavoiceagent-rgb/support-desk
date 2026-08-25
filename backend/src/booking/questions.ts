// Deciding what Adam confirms and what he still has to ask.
//
// This is the business's own rules, so it lives in code where it can be read
// and tested, not in a prompt where it drifts. The model's job is to turn
// these into readable English, not to work out what's missing.

import type { ExtractedBooking } from "./extract";
import { tidyAddress } from "./maps";
import type { VerifiedAddress } from "./maps";
import { describeLocal, describeTimeLocal } from "./pickup-time";
import type { PickupPlan } from "./pickup-time";
import { CAPACITY } from "./vehicles";

// Capacities Adam quotes when recommending a vehicle. The numbers themselves
// live in vehicles.ts, which is what actually picks the car — two copies of
// "a sedan takes three" is one copy too many, and the wrong one would show up
// in a customer's inbox.
export const SEDAN_CAPACITY = CAPACITY.SEDAN;
export const SUV_CAPACITY = CAPACITY.SUV;

export interface BookingReview {
  /** Facts we are sure of, phrased for the customer to check. */
  confirmations: string[];
  /** Things the email did not say that we need before the trip is bookable. */
  questions: string[];
  /** Warnings for the person reviewing the draft, never sent to the customer. */
  internalNotes: string[];
  vehicleSuggestion: string | null;
  /**
   * Do we know who the driver is actually meeting?
   *
   * A typed answer rather than something the composer works out from the
   * wording of a question. False means the reader might be the passenger and
   * might be an assistant booking for somebody else — and a draft that says
   * the driver will be "waiting for you" has quietly picked one.
   */
  knowsWhoTravels: boolean;
}

export interface ReviewInput {
  booking: ExtractedBooking;
  pickup: VerifiedAddress | null;
  dropoff: VerifiedAddress | null;
  stops: (VerifiedAddress | null)[];
  plan: PickupPlan;
  /** EXTERNAL trips are farmed out, so availability is not ours to promise. */
  isExternal: boolean;
  /** The address the email came from — always the booker's contact email. */
  senderEmail: string;
}

function addressLine(label: string, verified: VerifiedAddress | null, written: string | null): string | null {
  if (!written && !verified) return null;
  if (!verified) return `${label}: ${written} — could you confirm the full address?`;
  const address = tidyAddress(verified.formattedAddress);
  if (verified.isAirport) return `${label}: ${address}`;
  if (verified.partialMatch || !verified.postalCode) {
    return `${label}: ${address} — could you confirm this is right?`;
  }
  return `${label}: ${address}`;
}

export function reviewBooking(input: ReviewInput): BookingReview {
  const { booking, plan } = input;
  const confirmations: string[] = [];
  const questions: string[] = [];
  const internalNotes: string[] = [];

  // --- Who is travelling, and who is booking -----------------------------
  if (booking.bookerIsPassenger === true) {
    const name = booking.passengerName ?? booking.bookerName;
    // "Two of us" means the booker is in the car with company. We do not need
    // every name for a car booking, so say who it is under and how many.
    const others = booking.passengerCount !== null ? booking.passengerCount - 1 : 0;
    if (name) {
      confirmations.push(
        others > 0
          ? `Passenger and booker: ${name}, travelling with ${others} other${others > 1 ? "s" : ""}`
          : `Passenger and booker: ${name} (travelling yourself)`
      );
    } else {
      questions.push("the name the booking should be under");
    }
  } else if (booking.bookerIsPassenger === false) {
    if (booking.bookerName) confirmations.push(`Booker: ${booking.bookerName}`);
    if (booking.passengerName) confirmations.push(`Passenger: ${booking.passengerName}`);
    else questions.push("the passenger's name");
  } else {
    // The email never said. This is the case the business specifically wants
    // asked rather than assumed.
    if (booking.bookerName) confirmations.push(`Booker: ${booking.bookerName}`);
    questions.push("whether you are travelling yourself, or booking on someone else's behalf");
    if (!booking.passengerName) questions.push("the passenger's name, if it isn't you");
  }

  // --- Contact numbers ----------------------------------------------------
  //
  // The sender's own email is deliberately NOT confirmed back to them.
  //
  // It was, and it is the line that keeps producing nonsense: sitting next to
  // the contact-number question, a composer merges the two and asks whether an
  // email address is a phone number. That has now happened on two separate
  // live tickets. Two fixes were tried and both failed — first an instruction
  // in the compose prompt naming the exact sentence as forbidden, then
  // rewording the question to name a mobile and a driver. The model wrote it
  // anyway, both times.
  //
  // So the material goes instead of the instruction. Confirming somebody's
  // own address back to them, in an email they are reading at that address,
  // was the least useful line in the draft and the only one that has ever
  // been dangerous. If it is ever wanted again, it should be written by code
  // rather than handed to a model beside a question it can absorb.

  const bookerPhone = booking.bookerPhone;
  if (bookerPhone) {
    confirmations.push(`Contact number: ${bookerPhone} — is this the best number on the day?`);
  } else {
    // "A contact number" is abstract enough for a composer to weld onto the
    // email line above it — on ticket #67 it produced "we have your email;
    // could you confirm whether this is also the best contact number", which
    // asks whether an address is a phone. The compose prompt has forbidden
    // exactly that since 22 August, by name, and the model did it anyway two
    // days later. So the fix is the material rather than another instruction:
    // a question that names a mobile and a driver cannot be folded into a
    // sentence about an email address without reading as obvious nonsense.
    questions.push("a mobile number for the day of travel, so the driver can reach you");
  }

  if (booking.bookerIsPassenger === false) {
    if (booking.passengerPhone) {
      confirmations.push(`Passenger's number: ${booking.passengerPhone}`);
    } else if (booking.useBookerPhoneForPassenger) {
      confirmations.push("The driver will use your number to reach the passenger, as you asked");
    } else {
      questions.push("a mobile number for the passenger, so the driver can reach them directly");
    }
  }

  // --- Where -------------------------------------------------------------
  const pickupLine = addressLine("Pickup", input.pickup, booking.pickupAddressText);
  if (pickupLine) confirmations.push(pickupLine);
  else questions.push("the pickup address");

  input.stops.forEach((verified, i) => {
    const written = booking.stops[i]?.addressText ?? null;
    const line = addressLine(`Stop ${input.stops.length > 1 ? i + 1 : ""}`.trim(), verified, written);
    if (line) confirmations.push(line);
    if (booking.stops[i] && booking.stops[i].durationMinutes === null) {
      internalNotes.push(
        `Stop "${booking.stops[i].addressText}" has no stated duration — 15 minutes allowed.`
      );
    }
  });

  const dropoffLine = addressLine("Drop-off", input.dropoff, booking.dropoffAddressText);
  if (dropoffLine) confirmations.push(dropoffLine);
  else questions.push("the drop-off address");

  // --- When --------------------------------------------------------------
  //
  // Both candidate pickups exist when the only open question is which airport
  // rule applies. In that case there is nothing to ask about the time: it is
  // settled the moment they say which kind of flight it is, and asking anyway
  // is asking a customer to do arithmetic we have already done.
  const bothPickups = Boolean(plan.ifDomesticLocal && plan.ifInternationalLocal);

  if (!booking.requestedPickupLocal && !plan.recommendedPickupLocal && !bothPickups) {
    // Only the part we are actually missing. The flight time carries the
    // date, so a customer who gave one has already told us the day — asking
    // for it again reads as though nobody had read their email.
    questions.push(
      booking.flightTimeLocal
        ? "the time you'd like to be collected"
        : "the date and time you'd like to be collected"
    );
  }

  // The flight itself, read back so a misread time is caught by the one
  // person who knows it. "545pm" is how a customer writes it and how it has
  // to be understood; showing "5:45 PM" back is the cheapest possible check
  // on that reading, and it is the fact every other time on the booking is
  // derived from.
  if (booking.flightTimeLocal) {
    const flight = describeLocal(booking.flightTimeLocal);
    const number = booking.flightNumber ? ` (${booking.flightNumber})` : "";
    // Domestic or international, but only where it decides something.
    //
    // On a departure it decides the pickup: two hours at the airport or three,
    // so confirming it back is confirming the arithmetic. On an arrival it
    // decides nothing at all — the car meets the plane whatever kind of flight
    // it was — and a customer who never mentioned it reads it as a fact we
    // hold about their booking. "Flight lands 14:20" came back as "lands 2:20
    // PM (domestic)", which the email had not said and nothing needed.
    const kind =
      booking.flightDirection === "ARRIVAL"
        ? ""
        : booking.flightKind === "INTERNATIONAL"
          ? ", international"
          : booking.flightKind === "DOMESTIC"
            ? ", domestic"
            : "";
    confirmations.push(
      booking.flightDirection === "ARRIVAL"
        ? `Flight${number} lands: ${flight}${kind}`
        : `Flight${number} departs: ${flight}${kind}`
    );
  }

  const goingToAirport = booking.flightDirection === "DEPARTURE" || Boolean(input.dropoff?.isAirport);
  if (goingToAirport) {
    if (!booking.flightTimeLocal) questions.push("your flight departure time");
    if (!booking.flightKind) {
      // The same question either way — but where both answers are computable,
      // it is asked with the consequence of each attached.
      questions.push(
        bothPickups
          ? `whether the flight is domestic or international — if it is domestic we would collect you at ${describeLocal(plan.ifDomesticLocal)}, and if international at ${describeTimeLocal(plan.ifInternationalLocal)}`
          : "whether the flight is domestic or international"
      );
    }
    if (!booking.flightNumber) questions.push("your flight number, so we can watch for changes");
  }
  if (booking.flightDirection === "ARRIVAL" && !booking.flightNumber) {
    questions.push("your flight number, so the driver can track the landing time");
  }

  // --- Vehicle ------------------------------------------------------------
  let vehicleSuggestion: string | null = null;
  if (booking.vehicleRequested) {
    vehicleSuggestion = booking.vehicleRequested;
    confirmations.push(`Vehicle: ${booking.vehicleRequested}`);
  } else {
    const pax = booking.passengerCount;
    const bags = booking.luggageCount;
    if (pax !== null || bags !== null) {
      const needsSuv =
        (pax ?? 0) > SEDAN_CAPACITY.passengers || (bags ?? 0) > SEDAN_CAPACITY.bags;
      vehicleSuggestion = needsSuv ? "SUV" : "Sedan";
    } else {
      questions.push(
        `how many passengers and suitcases — a sedan takes up to ${SEDAN_CAPACITY.passengers} passengers and ${SEDAN_CAPACITY.bags} bags, an SUV up to ${SUV_CAPACITY.passengers} and ${SUV_CAPACITY.bags}`
      );
    }
  }

  // --- Notes for the person reviewing the draft ---------------------------
  if (input.isExternal) {
    internalNotes.push(
      "This trip goes outside the service area, so it has to be covered by a partner. The draft does not promise a vehicle."
    );
  }
  if (plan.requestedIsTooLate && plan.shortfallMinutes !== null) {
    // Spelled out, not "2026-09-05T14:10": a dispatcher reads this under time
    // pressure and should not have to decode a timestamp. Falls back to the
    // raw value rather than printing nothing if it cannot be parsed.
    const suggested = describeLocal(plan.recommendedPickupLocal) ?? plan.recommendedPickupLocal;
    internalNotes.push(
      `The requested pickup is ${plan.shortfallMinutes} minutes too late for the ${plan.leadMinutes}-minute airport rule. The draft suggests ${suggested} instead.`
    );
  }
  if (plan.ifDomesticLocal && plan.ifInternationalLocal) {
    internalNotes.push(
      `Flight kind not stated. Pickup is set to ${describeLocal(plan.ifInternationalLocal)} — the international time, which is the earlier of the two. If it turns out to be domestic, it moves to ${describeTimeLocal(plan.ifDomesticLocal)}.`
    );
  }
  // Which address, and whether the draft actually asked about it.
  //
  // This said "one of the addresses — the draft asks the customer to confirm
  // it" no matter which end was unsure. On tickets #67 and #72 the unsure
  // address was LaGuardia, where the draft says nothing at all: an airport is
  // its own address and needs no postcode confirmed. So the note warned about
  // an ask that had not been made, and did not say which place it meant —
  // leaving a reviewer hunting through a draft for a question that was not
  // there.
  const unsure = [
    input.pickup?.partialMatch ? { label: "pickup", place: input.pickup } : null,
    input.dropoff?.partialMatch ? { label: "drop-off", place: input.dropoff } : null,
  ].filter((x): x is { label: string; place: VerifiedAddress } => x !== null);

  for (const { label, place } of unsure) {
    const where = tidyAddress(place.formattedAddress);
    internalNotes.push(
      place.isAirport
        ? `Google wasn't certain the ${label} is "${where}" — but it is an airport, so the draft states it without asking. Worth a glance.`
        : `Google wasn't certain the ${label} is "${where}" — the draft asks the customer to confirm it.`
    );
  }
  if (!input.pickup && booking.pickupAddressText) {
    internalNotes.push(`Could not verify the pickup address "${booking.pickupAddressText}" on the map.`);
  }
  if (!input.dropoff && booking.dropoffAddressText) {
    internalNotes.push(`Could not verify the drop-off address "${booking.dropoffAddressText}" on the map.`);
  }

  return {
    confirmations,
    questions,
    internalNotes,
    vehicleSuggestion,
    // Known when somebody is named, or when the reader has said they are
    // travelling themselves. Not known otherwise — including the commonest
    // case of all, an email that simply never says.
    knowsWhoTravels: Boolean(booking.passengerName) || booking.bookerIsPassenger === true,
  };
}

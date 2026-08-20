// Deciding what Adam confirms and what he still has to ask.
//
// This is the business's own rules, so it lives in code where it can be read
// and tested, not in a prompt where it drifts. The model's job is to turn
// these into readable English, not to work out what's missing.

import type { ExtractedBooking } from "./extract";
import { tidyAddress } from "./maps";
import type { VerifiedAddress } from "./maps";
import type { PickupPlan } from "./pickup-time";

/** Capacities Adam quotes when recommending a vehicle. */
export const SEDAN_CAPACITY = { passengers: 3, bags: 3 };
export const SUV_CAPACITY = { passengers: 6, bags: 6 };

export interface BookingReview {
  /** Facts we are sure of, phrased for the customer to check. */
  confirmations: string[];
  /** Things the email did not say that we need before the trip is bookable. */
  questions: string[];
  /** Warnings for the person reviewing the draft, never sent to the customer. */
  internalNotes: string[];
  vehicleSuggestion: string | null;
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
  confirmations.push(`Email for updates: ${input.senderEmail}`);

  const bookerPhone = booking.bookerPhone;
  if (bookerPhone) {
    confirmations.push(`Contact number: ${bookerPhone} — is this the best number on the day?`);
  } else {
    questions.push("a contact number for the day of travel");
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
  if (!booking.requestedPickupLocal && !plan.recommendedPickupLocal) {
    questions.push("the date and time you'd like to be collected");
  }

  const goingToAirport = booking.flightDirection === "DEPARTURE" || Boolean(input.dropoff?.isAirport);
  if (goingToAirport) {
    if (!booking.flightTimeLocal) questions.push("your flight departure time");
    if (!booking.flightKind) questions.push("whether the flight is domestic or international");
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
    internalNotes.push(
      `The requested pickup is ${plan.shortfallMinutes} minutes too late for the ${plan.leadMinutes}-minute airport rule. The draft suggests ${plan.recommendedPickupLocal} instead.`
    );
  }
  if (input.pickup?.partialMatch || input.dropoff?.partialMatch) {
    internalNotes.push("Google wasn't confident about one of the addresses — the draft asks the customer to confirm it.");
  }
  if (!input.pickup && booking.pickupAddressText) {
    internalNotes.push(`Could not verify the pickup address "${booking.pickupAddressText}" on the map.`);
  }
  if (!input.dropoff && booking.dropoffAddressText) {
    internalNotes.push(`Could not verify the drop-off address "${booking.dropoffAddressText}" on the map.`);
  }

  return { confirmations, questions, internalNotes, vehicleSuggestion };
}

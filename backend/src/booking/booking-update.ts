// What a customer's reply means for a booking that already exists.
//
// Adam re-reads a reply and keeps his notes current. That was the whole of it,
// and it was not enough: on ticket #73 the reservation happened to be created
// after the reply, so the flight and the phone number landed on it by luck of
// ordering. Press "Create reservation" first — which is the normal order,
// because you create the booking and then chase the details — and the reply
// updated a set of notes nobody reads while the car stayed booked for the
// wrong time.
//
// The dangerous case is precise. When the flight kind is unknown the draft
// books the international time, because early costs a wait and late costs the
// flight. If the customer then says "it's domestic" the car sits for an extra
// hour, which is only annoying. If the draft had been told "domestic" and the
// customer corrects it to "international", the car is an hour too late and the
// passenger misses check-in. Nothing here may quietly leave that standing.
//
// Pure arithmetic on what the booking already holds. No map lookup, no model:
// the drive time was worked out once, paid for once, and is still sitting in
// the gap between the pickup and the check-in deadline.

import { DateTime } from "luxon";
import {
  INTERNATIONAL_LEAD_MINUTES,
  OPERATING_TIME_ZONE,
  leadMinutesFor,
  type FlightKind,
} from "./pickup-time";

/** The parts of a booking this reads. Deliberately not the whole trip. */
export interface BookingNow {
  pickupAt: Date;
  flightAt: Date | null;
  flightKind: FlightKind | null;
  flightNumber: string | null;
  passengerPhone: string | null;
  passengerCount: number | null;
  luggageCount: number | null;
  status: string;
}

/** What the reply established. Absent means the reply did not say. */
export interface FactsNow {
  flightTimeLocal?: string | null;
  flightKind?: FlightKind | null;
  flightNumber?: string | null;
  passengerPhone?: string | null;
  passengerCount?: number | null;
  luggageCount?: number | null;
}

export interface BookingPatch {
  pickupAt?: Date;
  flightAt?: Date;
  flightKind?: FlightKind;
  flightNumber?: string;
  passengerPhone?: string;
  passengerCount?: number;
  luggageCount?: number;
}

export interface BookingUpdate {
  patch: BookingPatch;
  /** One line each, for the note on the ticket. Plain English, no ids. */
  said: string[];
  /**
   * Things that changed but that the code would not act on, and why.
   *
   * These are the honest half. A flight arriving on a booking that never had
   * one has no drive time behind it, so there is nothing to work the pickup
   * back from and guessing would be worse than saying so.
   */
  needsAPerson: string[];
}

/**
 * The lead time the pickup was actually built on.
 *
 * A booking with no stated flight kind was timed as international — that is
 * what the draft does when the choice is open, and reading it any other way
 * would compute a shift from a number nobody used.
 */
function leadBehind(kind: FlightKind | null): number {
  return kind ? leadMinutesFor(kind) : INTERNATIONAL_LEAD_MINUTES;
}

const local = (at: Date) => DateTime.fromJSDate(at).setZone(OPERATING_TIME_ZONE);
const when = (at: Date) => local(at).toFormat("d LLL, h:mm a");

/** Nothing to do: the reply repeated what the booking already says. */
export const NO_UPDATE: BookingUpdate = { patch: {}, said: [], needsAPerson: [] };

export function bookingUpdateFrom(trip: BookingNow, facts: FactsNow): BookingUpdate {
  // A finished or cancelled job is history. Rewriting it because a late email
  // mentioned a flight would corrupt the record of what actually ran.
  if (trip.status !== "SCHEDULED") return NO_UPDATE;

  const patch: BookingPatch = {};
  const said: string[] = [];
  const needsAPerson: string[] = [];

  const newFlightAt = facts.flightTimeLocal
    ? DateTime.fromISO(facts.flightTimeLocal, { zone: OPERATING_TIME_ZONE })
    : null;
  const flightAtChanged =
    newFlightAt?.isValid && newFlightAt.toMillis() !== trip.flightAt?.getTime();
  const kindChanged = Boolean(facts.flightKind) && facts.flightKind !== trip.flightKind;

  if (flightAtChanged) patch.flightAt = newFlightAt!.toJSDate();
  if (kindChanged) patch.flightKind = facts.flightKind!;

  if (flightAtChanged || kindChanged) {
    const anchor = patch.flightAt ?? trip.flightAt;

    if (!trip.flightAt) {
      // Nothing to measure the drive against, so the pickup stays where a
      // person put it and that person gets told why.
      said.push(
        `Flight ${anchor ? when(anchor) : "time"}${facts.flightKind ? `, ${facts.flightKind.toLowerCase()}` : ""} — recorded on the booking.`
      );
      needsAPerson.push(
        "The booking had no flight on it before, so there is no drive time to work a new pickup back from. Check the pickup time yourself."
      );
    } else {
      // The gap the pickup was built on: drive, stops and buffer, whatever
      // they came to. Preserved exactly, so only the check-in deadline moves.
      const slackMinutes = local(trip.flightAt)
        .minus({ minutes: leadBehind(trip.flightKind) })
        .diff(local(trip.pickupAt), "minutes").minutes;

      const movedTo = local(anchor!)
        .minus({ minutes: leadBehind(patch.flightKind ?? trip.flightKind) })
        .minus({ minutes: slackMinutes });

      if (flightAtChanged) {
        said.push(`Flight moved to ${when(patch.flightAt!)} — the booking said ${when(trip.flightAt)}.`);
      }
      if (kindChanged) {
        said.push(
          trip.flightKind
            ? `Flight is ${patch.flightKind!.toLowerCase()}, not ${trip.flightKind.toLowerCase()}.`
            : `Flight is ${patch.flightKind!.toLowerCase()} — the pickup had been timed as international, which is what we do when nobody has said.`
        );
      }

      if (Math.abs(movedTo.diff(local(trip.pickupAt), "minutes").minutes) >= 1) {
        patch.pickupAt = movedTo.toJSDate();
        said.push(
          `Pickup moved from ${when(trip.pickupAt)} to ${when(patch.pickupAt)}, keeping the same ${Math.round(slackMinutes)} minutes for the drive.`
        );
      }
    }
  }

  if (facts.flightNumber && facts.flightNumber !== trip.flightNumber) {
    patch.flightNumber = facts.flightNumber;
    said.push(`Flight number ${facts.flightNumber}.`);
  }
  if (facts.passengerPhone && facts.passengerPhone !== trip.passengerPhone) {
    patch.passengerPhone = facts.passengerPhone;
    said.push(`Contact number ${facts.passengerPhone}.`);
  }

  // Counts can make the booked car too small, and that is not something to fix
  // silently — a bigger car may not exist that day, and the price changes.
  if (typeof facts.passengerCount === "number" && facts.passengerCount !== trip.passengerCount) {
    patch.passengerCount = facts.passengerCount;
    said.push(`Passengers: ${trip.passengerCount ?? "not stated"} → ${facts.passengerCount}.`);
    needsAPerson.push("The passenger count changed. Check the car on the booking is still big enough.");
  }
  if (typeof facts.luggageCount === "number" && facts.luggageCount !== trip.luggageCount) {
    patch.luggageCount = facts.luggageCount;
    said.push(`Bags: ${trip.luggageCount ?? "not stated"} → ${facts.luggageCount}.`);
    needsAPerson.push("The luggage count changed. Check the car on the booking is still big enough.");
  }

  return { patch, said, needsAPerson };
}

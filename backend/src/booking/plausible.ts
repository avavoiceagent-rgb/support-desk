// Is this answer one a car service could actually be looking at?
//
// Written after a customer was emailed a drop-off in Oklahoma City. They had
// typed "JFK"; Google returned "John F. Kennedy, Oklahoma City, OK 73117" and
// meant it — not a partial match, not a guess it flagged. The Routes API then
// faithfully measured the drive at 1,341 minutes, the pickup was worked back
// twenty-two hours and landed on the day before the flight, and the whole
// thing went out over somebody's name.
//
// Nothing in the chain was broken. Every step did exactly what it was told
// with what it was given. What was missing was anywhere that asked whether
// the answer made sense — so this is that place, and it deliberately does not
// care WHY a number is wrong. A geocode to the wrong state, a routing engine
// having a bad day, a customer typing a city we do not serve: all of them
// arrive here as a drive nobody would take, and all of them stop.
//
// It refuses to state, never refuses to book. The desk still gets the ticket,
// the addresses and a plain sentence about what looked wrong; a person can
// look at it and carry on. What it will not do is put a number in front of a
// customer that nobody believes.

import { DateTime } from "luxon";
import { OPERATING_TIME_ZONE } from "./pickup-time";

/**
 * The longest drive this desk could be looking at, in minutes.
 *
 * Four hours reaches Boston, Washington and well past Philadelphia — the
 * whole of the market the partner network covers, and then some. It is not a
 * rule about what the company will accept; it is the point past which a
 * number is far more likely to be a mistake than a booking, and where saying
 * nothing beats saying something wrong.
 */
export const LONGEST_PLAUSIBLE_DRIVE_MINUTES = 4 * 60;

export interface PlausibilityInput {
  /** What the Routes API measured, or null when it could not. */
  driveMinutes: number | null;
  /** Where the drive ends, as Google resolved it — for the sentence. */
  dropoffDescription?: string | null;
  /** The pickup the arithmetic produced, New York wall clock. */
  pickupAtLocal?: string | null;
  /** The flight it was worked back from, same clock. */
  flightAtLocal?: string | null;
}

/**
 * What is wrong with this, in words a person can act on. Empty when nothing is.
 *
 * Plural because two of these fire together on the same bad geocode, and each
 * says something the other does not: one names the drive, the other names the
 * day. A reader who sees both knows immediately it is the address.
 */
export function implausible(input: PlausibilityInput): string[] {
  const problems: string[] = [];

  const drive = input.driveMinutes;
  if (typeof drive === "number" && Number.isFinite(drive) && drive > LONGEST_PLAUSIBLE_DRIVE_MINUTES) {
    const hours = Math.round((drive / 60) * 10) / 10;
    problems.push(
      `The drive comes out at ${hours} hours${
        input.dropoffDescription ? ` to "${input.dropoffDescription}"` : ""
      }. That is not a journey this desk books, so the address is almost certainly not the one the customer meant. Check it before anything goes out.`
    );
  }

  const pickup = parse(input.pickupAtLocal);
  const flight = parse(input.flightAtLocal);
  if (pickup && flight && !pickup.hasSame(flight, "day")) {
    // Not "more than N hours before": the calendar day is what a person
    // checks, and it is what made the Oklahoma booking obviously wrong at a
    // glance — collected Monday evening for a Tuesday evening flight.
    problems.push(
      `The pickup works out as ${pickup.toFormat("cccc d LLLL")} for a flight on ${flight.toFormat(
        "cccc d LLLL"
      )}. A car sent the day before a flight is nearly always a sign the arithmetic was given something wrong.`
    );
  }

  return problems;
}

function parse(local: string | null | undefined): DateTime | null {
  if (!local) return null;
  const dt = DateTime.fromISO(local, { zone: OPERATING_TIME_ZONE });
  return dt.isValid ? dt : null;
}

// Does the new pickup time still get them to the airport?
//
// Nothing asked. A customer wrote in asking to move T-10310 ninety minutes,
// the desk moved it, told the driver, and emailed a cheerful confirmation —
// and at no point did anything look at the flight. That trip happened to
// carry none, so the test was safe. The next one will not be.
//
// This is the same arithmetic the first draft does, run against a time a
// person typed instead of one the code worked out. It is the second half of a
// rule that was only ever enforced on the way in.
//
// A warning, never a refusal. The clash check in ops/trips.ts already settles
// the principle: refusing a tight-but-possible turnaround that a dispatcher
// has chosen on purpose would be the code overruling the person who can see
// the road. A flight can be missed on purpose too — the customer may have
// rebooked, or be checked in already. So this says the number out loud and
// gets out of the way.

import { DateTime } from "luxon";
import { OPERATING_TIME_ZONE, leadMinutesFor, type FlightKind } from "./pickup-time";

export interface LateChangeInput {
  /** The new pickup, New York wall clock: "2026-09-03T16:00". */
  pickupAtLocal: string;
  /** The flight it is timed around. Null on a booking with no flight. */
  flightAt: Date | null;
  flightKind: FlightKind | null;
  /**
   * ARRIVAL or DEPARTURE.
   *
   * The whole question here — "will they still make it" — only exists for a
   * departure. On an arrival the flight is not a deadline the pickup has to
   * beat; it is the thing the pickup waits for. Read as a departure, a 6:05 PM
   * landing collected at 6:05 PM came out as three hours too late, which is
   * what a dispatcher was shown.
   */
  flightDirection?: "ARRIVAL" | "DEPARTURE" | null;
  /**
   * The drive, in minutes, as the booking was originally built.
   *
   * Recovered from the booking itself rather than asked of Google again: the
   * gap between the old pickup and the old check-in deadline is what the
   * drive and its cushion came to, and it is already paid for.
   */
  allowanceMinutes: number;
}

/**
 * A sentence for the person about to save, or null when there is nothing to
 * say.
 *
 * Null covers every case where we genuinely do not know: no flight on the
 * booking, an unreadable time, a pickup that is fine. Silence here has to mean
 * "no objection", never "could not tell" — so anything unknown returns null
 * only because there is no honest warning to give, and the caller is told
 * nothing rather than told it is safe.
 */
export function lateChangeWarning(input: LateChangeInput): string | null {
  if (!input.flightAt) return null;
  // Nothing to be late for. The plane sets the time and the driver waits.
  if (input.flightDirection === "ARRIVAL") return null;

  const pickup = DateTime.fromISO(input.pickupAtLocal, { zone: OPERATING_TIME_ZONE });
  if (!pickup.isValid) return null;

  const flight = DateTime.fromJSDate(input.flightAt).setZone(OPERATING_TIME_ZONE);
  // Unknown kind is read as international, the same way the draft reads it:
  // the earlier of the two, because early costs a wait and late costs the
  // flight.
  const lead = leadMinutesFor(input.flightKind ?? "INTERNATIONAL");
  const mustLeaveBy = flight.minus({ minutes: lead + Math.max(0, input.allowanceMinutes) });

  const lateBy = Math.round(pickup.diff(mustLeaveBy, "minutes").minutes);
  if (lateBy <= 0) return null;

  const kind = input.flightKind ? input.flightKind.toLowerCase() : "international";
  return (
    `That is ${lateBy} ${lateBy === 1 ? "minute" : "minutes"} too late for the ` +
    `${flight.toFormat("h:mm a")} ${kind} flight — the airport wants them there by ` +
    `${flight.minus({ minutes: lead }).toFormat("h:mm a")}, and the drive was built at ` +
    `${Math.round(input.allowanceMinutes)} minutes. Leaving by ` +
    `${mustLeaveBy.toFormat("h:mm a")} makes it. Save anyway if you know something the booking does not.`
  );
}

/**
 * How long the booking allowed for the drive, from the booking itself.
 *
 * Negative when the original pickup was already tighter than the rule, which
 * is possible on a booking a person set by hand. Clamped to zero by the
 * caller rather than here, so the oddity stays visible to anyone reading.
 */
export function allowanceFrom(
  pickupAt: Date,
  flightAt: Date | null,
  flightKind: FlightKind | null,
  flightDirection?: "ARRIVAL" | "DEPARTURE" | null
): number {
  if (!flightAt || flightDirection === "ARRIVAL") return 0;
  const flight = DateTime.fromJSDate(flightAt).setZone(OPERATING_TIME_ZONE);
  const pickup = DateTime.fromJSDate(pickupAt).setZone(OPERATING_TIME_ZONE);
  const lead = leadMinutesFor(flightKind ?? "INTERNATIONAL");
  return Math.round(flight.minus({ minutes: lead }).diff(pickup, "minutes").minutes);
}

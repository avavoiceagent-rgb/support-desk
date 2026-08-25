// Whether a pickup time somebody just typed still makes the flight.
//
// The twin of backend/src/booking/late-change.ts, and here for the reason
// pastBookingWarning is here: the warning has to appear as the time is typed,
// and a round trip to the server per keystroke is not that.
//
// The two lead times are duplicated across the two files, which is a genuine
// risk — change one without the other and a customer is warned by one screen
// and not by the other. Both sides have tests that name the numbers, so a
// drift shows up as a red test rather than as a missed flight.

import { atTime, fromDateTimeInput } from "./time";

const DOMESTIC_LEAD_MINUTES = 120;
const INTERNATIONAL_LEAD_MINUTES = 180;
const MINUTE = 60_000;

/**
 * An unstated kind is read as international, exactly as the draft reads it.
 *
 * Silence would be the dangerous answer: taken as domestic, a pickup an hour
 * too late for an international departure looks perfectly fine.
 */
const leadFor = (kind: string | null) =>
  kind === "DOMESTIC" ? DOMESTIC_LEAD_MINUTES : INTERNATIONAL_LEAD_MINUTES;

export interface FlightBooking {
  /** ISO instant from the API. Null on a booking with no flight. */
  flightAt: string | null;
  flightKind: string | null;
  /**
   * ARRIVAL or DEPARTURE.
   *
   * The question this file asks — will they still make it — only exists for a
   * departure. On an arrival the flight is not a deadline to beat; it is the
   * thing the pickup waits for. Read as a departure, a 6:05 PM landing
   * collected at 6:05 PM came out as three hours too late, in red, on a
   * booking that was exactly right.
   */
  flightDirection?: string | null;
  /** The pickup as it stands, which is what the drive was built around. */
  pickupAt: string;
}

/** When they have to be at the airport, as an instant in milliseconds. */
function deadlineMs(booking: FlightBooking): number | null {
  // Nothing to be late for. The plane sets the time and the driver waits.
  if (!booking.flightAt || booking.flightDirection === "ARRIVAL") return null;
  const flight = new Date(booking.flightAt).getTime();
  return Number.isNaN(flight) ? null : flight - leadFor(booking.flightKind) * MINUTE;
}

/**
 * The minutes the booking allowed for the drive, read back off itself.
 *
 * The gap between the pickup and the check-in deadline is the drive plus its
 * cushion — already measured, already paid for. Asking Google again would
 * cost money and answer for a different day's traffic.
 *
 * Never negative: a booking already tighter than the rule is a problem, but
 * not one that should make the next change look better than it is.
 */
export function allowanceFrom(booking: FlightBooking): number {
  const deadline = deadlineMs(booking);
  if (deadline === null) return 0;
  const pickup = new Date(booking.pickupAt).getTime();
  return Math.max(0, Math.round((deadline - pickup) / MINUTE));
}

/**
 * The sentence to put in front of somebody about to save, or null.
 *
 * Null only ever means "no honest objection" — no flight on the booking, a
 * time that cannot be read, or a pickup that still makes it. It never means
 * "could not tell".
 *
 * A warning, not a refusal. The clash check in ops/trips.ts settles the
 * principle: refusing a tight-but-possible choice a dispatcher made on purpose
 * would be the code overruling the person who can see the road. A flight can
 * be missed on purpose too — rebooked, or already checked in.
 */
export function lateChangeWarning(booking: FlightBooking, newPickupLocal: string): string | null {
  const deadline = deadlineMs(booking);
  if (deadline === null || !newPickupLocal) return null;

  // The form hands back a wall clock with no zone. Read as New York, like
  // every other time this desk takes from a person.
  const proposed = new Date(fromDateTimeInput(newPickupLocal)).getTime();
  if (Number.isNaN(proposed)) return null;

  const allowance = allowanceFrom(booking);
  const mustLeaveBy = deadline - allowance * MINUTE;
  const lateBy = Math.round((proposed - mustLeaveBy) / MINUTE);
  if (lateBy <= 0) return null;

  const kind = (booking.flightKind ?? "INTERNATIONAL").toLowerCase();
  return (
    `That is ${lateBy} ${lateBy === 1 ? "minute" : "minutes"} too late for the ` +
    `${atTime(booking.flightAt!)} ${kind} flight — the airport wants them there by ` +
    `${atTime(new Date(deadline).toISOString())}, and the drive was built at ` +
    `${allowance} minutes. Leaving by ${atTime(new Date(mustLeaveBy).toISOString())} makes it. ` +
    `Save anyway if you know something the booking does not.`
  );
}

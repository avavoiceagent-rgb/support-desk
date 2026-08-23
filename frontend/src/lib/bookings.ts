// Whether a booking has already happened, and how to say so.
//
// Editing a finished job is not a mistake — it is how a billing dispute gets
// corrected. INV-10032 on the live desk is exactly that: "booked 3 hours,
// billed 4 — customer asks why", and answering it means changing a trip dated
// last month. So this warns rather than refuses.
//
// What it guards against is the other reading: somebody sees "move it an hour
// later", opens the booking the email names, and moves a car that came home
// four weeks ago.

import { onDate, when } from "./time";

export interface BookingMoment {
  status: string;
  pickupAt: string;
}

/**
 * Why this booking is in the past, in words, or null if it is still ahead.
 *
 * The status is checked before the clock: a job cancelled yesterday and a job
 * cancelled for next Tuesday are both cancelled, and neither is something you
 * move by editing the pickup time.
 */
export function alreadyHappened(booking: BookingMoment, now: Date = new Date()): string | null {
  switch (booking.status) {
    case "COMPLETED":
      return `was completed on ${onDate(booking.pickupAt)}`;
    case "NO_SHOW":
      return `was recorded as a no-show on ${onDate(booking.pickupAt)}`;
    case "CANCELLED":
      return "has been cancelled";
    case "IN_PROGRESS":
      return "is out on the road now";
    default:
      break;
  }
  // Still scheduled, but the hour has gone by — which is its own kind of
  // problem, and not one that moving the time quietly fixes.
  return new Date(booking.pickupAt).getTime() < now.getTime()
    ? `was due at ${when(booking.pickupAt)}, which has passed`
    : null;
}

/** The sentence to put in front of somebody about to edit it. */
export function pastBookingWarning(
  booking: BookingMoment,
  reference: string,
  now?: Date
): string | null {
  const why = alreadyHappened(booking, now);
  return why
    ? `${reference} ${why}. Changing it now corrects the record rather than moving a car — which is right for a billing question, and wrong if you meant to move a booking.`
    : null;
}

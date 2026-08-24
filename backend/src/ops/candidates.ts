// Who can take this trip — the answer, ready to act on.
//
// Every part of this already existed and none of it was joined up.
// `findAvailableDrivers` has known since it was written which drivers a shift
// covers, who is already out, and whose car is big enough; `suggestAffiliates`
// has known which partners to ring. Both were called only by their own tests,
// so a dispatcher looking at a new booking still had to work it out from the
// schedule board by eye.
//
// Partners are worked out only when nobody of ours is free. That is the real
// order of the decision — you do not price a farm-out while a car is sitting
// there — and it also keeps the rate-card queries off the common path.

import { findAvailableDrivers, suggestAffiliates, type AvailableDriver } from "./availability";
import { describeOffer } from "./dispatch";
import { quoteTripForAffiliate, type TripQuote } from "./pricing";
import type { TripRecord } from "./lookup";

export interface PartnerCandidate {
  affiliateId: string;
  company: string;
  phone: string;
  /** COVERS_AREA when the trip leaves our patch, OVERFLOW when we are simply out of cars. */
  reason: "COVERS_AREA" | "OVERFLOW";
  /** 1 (first call) to 5 (last resort). */
  preference: number;
  /** What their card says, or why it says nothing. */
  quote: TripQuote;
}

export interface TripCandidates {
  drivers: AvailableDriver[];
  /** Only populated when no driver of ours is free. */
  partners: PartnerCandidate[];
  /** Why the partner list is what it is, for the screen to say out loud. */
  fallbackReason: "OUT_OF_AREA" | "NO_CAR_FREE" | null;
  /**
   * The message a driver or partner would receive, exactly as it will be sent.
   *
   * Shown before anybody presses the button. It is written by the same
   * function that sends it, so what is on the screen is what goes out rather
   * than a description of it.
   */
  offerText: string;
}

/**
 * The trip leaves NY/NJ, and so needs a partner however free our drivers are.
 *
 * Read from the stored state rather than re-decided here: it is the same code
 * that decided INTERNAL or EXTERNAL when the email arrived, and two places
 * deciding it separately would eventually disagree in front of a customer.
 */
const HOME_STATES = ["NY", "NJ"];

function leavesTheArea(trip: TripRecord): boolean {
  // Unknown is not "outside". A trip with no state recorded gets the ordinary
  // treatment rather than being farmed out on missing information.
  if (!trip.dropoffState) return false;
  return !HOME_STATES.includes(trip.dropoffState);
}

export async function candidatesForTrip(trip: TripRecord): Promise<TripCandidates> {
  const outOfArea = leavesTheArea(trip);

  // No point listing our own drivers for a job we cannot legally or
  // practically cover: an out-of-area trip is a partner's from the start.
  const drivers = outOfArea
    ? []
    : await findAvailableDrivers({
        pickupAt: trip.pickupAt,
        hours: trip.bookedHours,
        vehicleClass: trip.vehicleClass,
      });

  const offerText = describeOffer(trip);

  if (drivers.length > 0) {
    return { drivers, partners: [], fallbackReason: null, offerText };
  }

  const suggestions = await suggestAffiliates(
    outOfArea
      ? { states: trip.dropoffState ? [trip.dropoffState] : [] }
      : { overflow: true }
  );

  // Priced one at a time rather than in a batch: each is a couple of small
  // reads, the list is a handful long, and a partner who cannot be priced
  // still belongs on it with the reason showing.
  const partners: PartnerCandidate[] = [];
  for (const s of suggestions) {
    partners.push({
      affiliateId: s.affiliateId,
      company: s.company,
      phone: s.phone,
      reason: s.reason,
      preference: s.preference,
      quote: await quoteTripForAffiliate(trip, s.affiliateId),
    });
  }

  return {
    drivers: [],
    partners,
    fallbackReason: outOfArea ? "OUT_OF_AREA" : "NO_CAR_FREE",
    offerText,
  };
}

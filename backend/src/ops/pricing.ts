// What a partner will charge for one specific job.
//
// The two halves of this have existed separately for a while: a partner's
// rate card, priced in bands measured from their base, and a trip with a
// pickup address. Nothing joined them, because a trip had no coordinates and
// a band is a distance. Now it does, so the desk can see the number before
// handing the work over rather than after the invoice arrives.
//
// Every failure here is a sentence, not a null. "No quote" and "no quote
// because we never recorded where they are based" send a dispatcher to two
// completely different places.

import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { affiliates } from "../db/schema";
import type { TripRecord } from "./lookup";
import { listZones, milesBetween, quote, type Quote } from "./zones";

export type TripQuote =
  | { priced: true; miles: number; quote: Quote }
  | { priced: false; reason: string };

/** One decimal is as much precision as a band boundary deserves. */
function round(miles: number): number {
  return Math.round(miles * 10) / 10;
}

/**
 * The price this partner's card gives for this job, or why it gives none.
 *
 * Measured from the partner's base to the PICKUP, not to the drop-off and not
 * along the route. That is how the bands are drawn: a partner charges by how
 * far they have to send a car to start the job, and what happens after that
 * is the hourly rate's problem.
 */
export async function quoteTripForAffiliate(
  trip: TripRecord,
  affiliateId: string
): Promise<TripQuote> {
  const [partner] = await db.select().from(affiliates).where(eq(affiliates.id, affiliateId)).limit(1);
  if (!partner) return { priced: false, reason: "That partner no longer exists." };

  if (partner.baseLat == null || partner.baseLng == null) {
    return {
      priced: false,
      reason: `We have not recorded where ${partner.company} is based, so their distance bands cannot be measured. Add a base address on their record.`,
    };
  }

  if (trip.pickupLat == null || trip.pickupLng == null) {
    return {
      priced: false,
      // Deliberately not "we'll geocode it now": a quote that silently
      // re-looks-up an address can answer differently from the one on the
      // booking, and a bill has to be reproducible.
      reason:
        "This booking has no pickup coordinates — it was created before we started keeping them, or the address never resolved. Rate cards price by distance, so this one has to be agreed by hand.",
    };
  }

  const miles = round(
    milesBetween(partner.baseLat, partner.baseLng, trip.pickupLat, trip.pickupLng)
  );
  const zones = await listZones(affiliateId);
  if (zones.length === 0) {
    return {
      priced: false,
      reason: `${partner.company} has no rate card yet — ${miles} miles out, agreed by hand.`,
    };
  }

  const priced = quote(zones, {
    miles,
    vehicleClass: trip.vehicleClass,
    hours: trip.bookedHours,
  });
  if (!priced) {
    // Two different failures, and the dispatcher can fix one of them.
    const band = zones.find(
      (z) => miles >= z.fromMiles && (z.toMiles === null || miles < z.toMiles)
    );
    return {
      priced: false,
      reason: band
        ? `${partner.company} does not price a ${trip.vehicleClass.toLowerCase()} in "${band.label}" (${miles} miles out).`
        : `${miles} miles out falls outside every band on ${partner.company}'s card.`,
    };
  }

  return { priced: true, miles, quote: priced };
}

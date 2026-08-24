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

/**
 * Whether this partner works where the car is actually needed.
 *
 * A partner is picked because they operate in the market the job happens in —
 * that is what an affiliate network is for. Measuring a Los Angeles firm's
 * rate card against a Manhattan pickup is arithmetic on a pairing that would
 * never be made, and answering it with a price dressed the mistake up as a
 * decision.
 *
 * Coverage is empty for a partner nobody has filled in, and an empty list is
 * not a claim that they cover nowhere — so it says nothing rather than
 * objecting.
 */
export function coverageGap(
  partner: { company: string; coverageStates: string[]; baseAddress: string | null },
  trip: { pickupState: string | null; dropoffState: string | null }
): string | null {
  if (partner.coverageStates.length === 0) return null;
  if (!trip.pickupState) return null;

  const covers = (state: string | null) =>
    Boolean(state) && partner.coverageStates.includes(state!);
  if (covers(trip.pickupState)) return null;

  const where = partner.baseAddress ? ` (${partner.baseAddress})` : "";
  const states = partner.coverageStates.join(", ");
  // The far end matters: a partner who covers the destination is the normal
  // way an out-of-area job gets done, and the car meets the customer there.
  // What that is NOT is this trip, whose pickup is somewhere they do not work.
  const alsoCoversDestination = covers(trip.dropoffState)
    ? ` They do cover ${trip.dropoffState}, where this trip ends — if they are meeting the customer at that end, the job to send them is the one that starts there.`
    : "";

  return `${partner.company}${where} covers ${states}. This pickup is in ${trip.pickupState}, so this is likely the wrong partner for it.${alsoCoversDestination}`;
}

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

  // Before any arithmetic: a price for a partner who does not work here is a
  // right answer to the wrong question.
  const gap = coverageGap(partner, trip);
  if (gap) return { priced: false, reason: gap };

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

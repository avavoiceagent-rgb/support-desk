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
  | { priced: true; miles: number; quote: Quote; note: string | null }
  | { priced: false; reason: string; note: string | null };

/**
 * A caution about operating authority, or null.
 *
 * This began life as a refusal and was wrong to be one. Two different facts
 * were being run together: how far a partner will travel, which their own
 * rate card states, and where they are licensed to work, which their coverage
 * states say. A Philadelphia firm quoting a Manhattan pickup is ordinary
 * intercity work — under about four hundred miles a single car drives the
 * whole route, and the card reaching that far is the partner saying so.
 * Whether they may pick up in New York is a separate question, and a licence
 * is not something this desk can check.
 *
 * So it is said alongside the price rather than instead of it. What actually
 * stops a quote is distance: a card that ends at 250 miles has nothing to say
 * about Los Angeles, and says so on its own.
 *
 * Empty coverage means nobody filled the partner in, which is not a claim
 * that they cover nowhere — so it stays quiet.
 */
export function coverageNote(
  partner: { company: string; coverageStates: string[] },
  trip: { pickupState: string | null; dropoffState: string | null }
): string | null {
  if (partner.coverageStates.length === 0) return null;
  if (!trip.pickupState) return null;

  const covers = (state: string | null) =>
    Boolean(state) && partner.coverageStates.includes(state!);
  if (covers(trip.pickupState)) return null;

  const states = partner.coverageStates.join(", ");
  // Where they cover the far end, say so: that is the ordinary shape of an
  // out-of-area job, and it may mean the work to send them is the one that
  // starts in their own city rather than this one.
  const farEnd = covers(trip.dropoffState)
    ? ` They do cover ${trip.dropoffState}, where this trip ends — if they are meeting the customer there, the job to send them is the one that starts at that end.`
    : "";

  return `${partner.company} covers ${states} and this pickup is in ${trip.pickupState}. Operating authority is local, so check they can work there.${farEnd}`;
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
  if (!partner) return { priced: false, reason: "That partner no longer exists.", note: null };

  const note = coverageNote(partner, trip);

  if (partner.baseLat == null || partner.baseLng == null) {
    return {
      priced: false,
      reason: `We have not recorded where ${partner.company} is based, so their distance bands cannot be measured. Add a base address on their record.`,
      note,
    };
  }

  if (trip.pickupLat == null || trip.pickupLng == null) {
    return {
      priced: false,
      note,
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
      note,
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
        : `${miles} miles out falls outside every band on ${partner.company}'s card — beyond the distance they have said they will travel.`,
      note,
    };
  }

  return { priced: true, miles, quote: priced, note };
}

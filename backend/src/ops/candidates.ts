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
import { describeOffer, lastSpokeTo } from "./dispatch";
import { listTripEvents } from "./trip-events";
import { quoteTripForAffiliate, type TripQuote } from "./pricing";
import type { TripRecord } from "./lookup";
import { serviceAreaFromStates } from "../booking/maps";
import { SERVICE_AREA_STATES } from "../types";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/client";
import { affiliates } from "../db/schema";

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

/**
 * The state of whoever already has this job.
 *
 * A booking that moves under a driver who accepted it at the old time is the
 * quiet failure this exists to catch: nothing errors, nothing looks wrong,
 * and a car turns up an hour late. Two separate questions, deliberately kept
 * apart — do they know, and can they still do it — because the answers call
 * for different actions.
 */
export interface AssignmentState {
  kind: "DRIVER" | "AFFILIATE";
  contactId: string;
  name: string;
  /**
   * False when the trip has been edited since we last said anything to them.
   * Null when we have never said anything at all — assigned by hand, never
   * offered, so there is nothing to be out of date.
   */
  toldOfLatest: boolean | null;
  /**
   * Whether a driver's shift still covers the booking and nothing else of
   * theirs clashes with it. Null for a partner: their availability is not
   * ours to know, and guessing at it would be inventing a fact.
   */
  stillAvailable: boolean | null;
}

export interface TripCandidates {
  drivers: AvailableDriver[];
  /** Only populated when no driver of ours is free. */
  partners: PartnerCandidate[];
  /** Who has it now, and whether that still holds. Null when nobody does. */
  assignment: AssignmentState | null;
  /** Why the partner list is what it is, for the screen to say out loud. */
  fallbackReason: "OUT_OF_AREA" | "NO_CAR_FREE" | null;
  /**
   * Why the list is as short as it is, when it is short.
   *
   * The desk asks several partners for a price at once, and the first job put
   * through that offered exactly one tick box — because one partner on the
   * roster covers Pennsylvania. Nothing said so, and a feature that works
   * perfectly while looking broken is the same as a broken one to the person
   * using it. Null when the list is long enough to explain itself.
   */
  coverageNote: string | null;
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
 * Both ends, through the one rule. This used to read the drop-off alone,
 * against a private copy of the state list, under a comment claiming it read
 * the stored decision — which it did not, and there is no stored decision for
 * it to have read. A **Philadelphia pickup coming back to Manhattan** has
 * `dropoffState: "NY"`, so it came out as ordinary local work and the screen
 * offered one of our own drivers a ninety-five mile run into Pennsylvania and
 * back, with nothing anywhere to say why that was wrong.
 *
 * Stops are not consulted because a trip does not keep their states — only
 * their text. A stop that leaves the area would have made the booking EXTERNAL
 * when the draft was written, which is where that is caught.
 *
 * Unknown is still not "outside": a trip with no states recorded gets the
 * ordinary treatment rather than being farmed out on missing information.
 * Showing a driver who turns out to be wrong is recoverable; hiding every
 * driver on a job that was ours all along is a dead end on the screen.
 */
function leavesTheArea(trip: TripRecord): boolean {
  return (
    serviceAreaFromStates([trip.pickupState, trip.dropoffState], SERVICE_AREA_STATES) === "EXTERNAL"
  );
}

/**
 * Whether the driver holding this trip could still be given it today.
 *
 * Asked with the trip itself excluded from the clash check — a driver is not
 * unavailable on account of the very job being asked about.
 */
async function driverStillFits(trip: TripRecord, driverId: string): Promise<boolean> {
  const free = await findAvailableDrivers({
    pickupAt: trip.pickupAt,
    hours: trip.bookedHours,
    vehicleClass: trip.vehicleClass,
    excludeTripId: trip.id,
  });
  return free.some((d) => d.driverId === driverId);
}

async function assignmentFor(trip: TripRecord): Promise<AssignmentState | null> {
  const contact = trip.driver
    ? { kind: "DRIVER" as const, id: trip.driver.id, name: trip.driver.name }
    : trip.affiliate
      ? { kind: "AFFILIATE" as const, id: trip.affiliate.id, name: trip.affiliate.company }
      : null;
  if (!contact) return null;

  const spokeAt = await lastSpokeTo(trip.id, { kind: contact.kind, id: contact.id });

  // When the booking last changed in a way anybody would call a change.
  //
  // Not `updatedAt`, which moves on every write — tidying the notes counted
  // as something the driver needed telling about. The events are the audit
  // trail, and they are only written when a field somebody cares about
  // actually moved, which is the same question being asked here.
  const events = await listTripEvents(trip.id);
  const lastChange = events.length ? events[events.length - 1].createdAt : trip.createdAt;

  return {
    kind: contact.kind,
    contactId: contact.id,
    name: contact.name,
    // A straight comparison, no slack. A change notice is written after the
    // edit is saved, so it is always the later of the two — an earlier
    // version of this allowed a second of tolerance and quietly reported a
    // booking edited moments after a message as still up to date.
    toldOfLatest: spokeAt ? spokeAt.getTime() >= lastChange.getTime() : null,
    stillAvailable:
      contact.kind === "DRIVER" ? await driverStillFits(trip, contact.id) : null,
  };
}

export async function candidatesForTrip(trip: TripRecord): Promise<TripCandidates> {
  const outOfArea = leavesTheArea(trip);
  const assignment = await assignmentFor(trip);

  // No point listing our own drivers for a job we cannot legally or
  // practically cover: an out-of-area trip is a partner's from the start.
  //
  // The trip excludes itself from the clash check here too, so that a job
  // needing a new driver does not hide the ones it is currently blocking.
  const drivers = outOfArea
    ? []
    : await findAvailableDrivers({
        pickupAt: trip.pickupAt,
        hours: trip.bookedHours,
        vehicleClass: trip.vehicleClass,
        excludeTripId: trip.id,
      });

  const offerText = describeOffer(trip);

  if (drivers.length > 0) {
    return {
      drivers,
      partners: [],
      fallbackReason: null,
      coverageNote: null,
      offerText,
      assignment,
    };
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
    coverageNote: outOfArea ? await coverageNoteFor(trip, partners.length) : null,
    offerText,
    assignment,
  };
}

/**
 * "Only 1 of your 11 partners covers PA."
 *
 * Said because the alternative is a screen that shows one tick box under a
 * heading promising a choice, and leaves the reader to guess whether that is
 * the roster or a bug. Null once there are enough to choose between, where the
 * list speaks for itself.
 */
async function coverageNoteFor(trip: TripRecord, found: number): Promise<string | null> {
  if (found > 2) return null;
  const where = trip.dropoffState;
  if (!where) return null;

  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(affiliates)
    .where(eq(affiliates.active, true));
  const total = row?.total ?? 0;

  // "None of your 1 partner cover PA" is what counting into every sentence
  // gets you. The count earns its place only where it is the point.
  if (found === 0) {
    return `No partner of yours covers ${where}. Add one, or widen a partner's coverage in Operations → Partners.`;
  }
  const roster = `${total} ${total === 1 ? "partner" : "partners"}`;
  return `Only ${found} of your ${roster} ${found === 1 ? "covers" : "cover"} ${where}, so that is all there is to ask. Widen a partner's coverage in Operations → Partners if you want a choice of price.`;
}

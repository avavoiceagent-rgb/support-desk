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
    return { drivers, partners: [], fallbackReason: null, offerText, assignment };
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
    assignment,
  };
}

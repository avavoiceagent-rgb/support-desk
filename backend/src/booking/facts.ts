// Keeping what a conversation has established, as it goes on.
//
// The facts behind a draft came from the first email and stopped there. So
// when Apurva answered "my contact number is 9978615599, the flight is
// international", the desk had both on the screen and neither on the booking:
// the reservation form still opened with no phone number and no flight kind,
// and somebody had to read the thread and retype them.
//
// The rule is one line long and it is the whole of the difficulty: a later
// email may ADD to what is known and may CORRECT it, but silence in a later
// email must never erase it. Most replies mention two or three things; if
// re-reading one overwrote the facts wholesale, a customer confirming their
// flight number would wipe their own pickup address.

import type { DraftFacts } from "../db/schema";

/** Fields where "" and null both mean the same nothing. */
function stated<T>(value: T | null | undefined): value is T {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim() !== "";
  return true;
}

/**
 * What we knew, updated with whatever the newer reading actually says.
 *
 * `incoming` wins field by field, but only where it states something. A
 * missing field in the newer reading leaves the older value alone.
 *
 * Stops are all-or-nothing rather than merged item by item: a list of stops
 * is a shape, not a set of independent facts, and half of one from each of
 * two emails is a route nobody described.
 */
/**
 * The booker name a re-read is allowed to contribute.
 *
 * A re-read may fill one in. It may not replace one.
 *
 * The extractor is told to fall back to the mailbox display name when a
 * message carries no sign-off. That is right for a first email and wrong for
 * every reply after it: "my number is 9978615599" is unsigned, so the reply
 * came back naming the mailbox owner, and the merge overwrote the name the
 * customer had actually signed with. Priya Raman became Amar Pant on the
 * strength of a phone number — on the live desk, twice, on tickets #84 and
 * #86, after the first draft had got it right.
 *
 * Who booked is established by the first email, where the sign-off is.
 * Somebody genuinely handing a booking to a colleague is a change a person
 * should make rather than one a model makes quietly on a re-read — and the
 * reply is sitting in the thread either way.
 *
 * A rule rather than an expression inside the caller, because it is a decision
 * about a customer's name and it deserves to be findable.
 */
export function bookerNameFromReply(
  established: string | null | undefined,
  fromReply: string | null | undefined
): string | null {
  if (established?.trim()) return null;
  return fromReply?.trim() ? fromReply : null;
}

export function mergeFacts(existing: DraftFacts, incoming: Partial<DraftFacts>): DraftFacts {
  const merged: DraftFacts = { ...existing };

  for (const key of Object.keys(incoming) as (keyof DraftFacts)[]) {
    if (key === "stops") continue;
    const value = incoming[key];
    if (stated(value)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (merged as any)[key] = value;
    }
  }

  if (incoming.stops && incoming.stops.length > 0) merged.stops = incoming.stops;

  return merged;
}

/**
 * The fields a newer reading changed, in words, for the ticket to show.
 *
 * A silent update to a booking somebody is working from is worse than no
 * update: this is what lets the desk say "the phone number and flight kind
 * came from their reply" rather than have them appear out of nowhere.
 */
export function describeFactChanges(before: DraftFacts, after: DraftFacts): string[] {
  const labels: Partial<Record<keyof DraftFacts, string>> = {
    passengerName: "Passenger",
    passengerPhone: "Passenger phone",
    bookerName: "Booker",
    bookerEmail: "Booker email",
    pickupAddress: "Pickup",
    dropoffAddress: "Drop-off",
    pickupAtLocal: "Pickup time",
    vehicleClass: "Car",
    passengerCount: "Passengers",
    luggageCount: "Bags",
    flightNumber: "Flight number",
    flightTimeLocal: "Flight time",
    flightKind: "Flight kind",
  };

  const changes: string[] = [];
  for (const [key, label] of Object.entries(labels) as [keyof DraftFacts, string][]) {
    const from = before[key];
    const to = after[key];
    if (from === to) continue;
    changes.push(stated(from) ? `${label}: ${from} → ${to}` : `${label}: ${to}`);
  }
  return changes;
}

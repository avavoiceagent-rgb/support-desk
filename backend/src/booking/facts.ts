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

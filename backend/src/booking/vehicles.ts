// Which class of car a booking needs.
//
// From the numbers, not from the prose. Passenger and luggage counts are
// already extracted, and the capacities are already written down as business
// rules — so the class is arithmetic, and CLAUDE.md is explicit that
// arithmetic does not go to a model.
//
// What the customer wrote still matters, but as a floor rather than as the
// answer: somebody asking for an SUV to carry one passenger gets an SUV. What
// it must never do is shrink the car. Reading "an SUV or a van" as VAN because
// van was tested first was harmless; reading it as something smaller than the
// party would not be.

import type { VehicleClass } from "../db/schema";

export const CAPACITY: Record<VehicleClass, { passengers: number; bags: number }> = {
  SEDAN: { passengers: 3, bags: 3 },
  SUV: { passengers: 6, bags: 6 },
  VAN: { passengers: 7, bags: 7 },
  SPRINTER: { passengers: 14, bags: 14 },
};

/** Smallest first, which is also the order they are compared in. */
export const CLASSES_BY_SIZE: VehicleClass[] = ["SEDAN", "SUV", "VAN", "SPRINTER"];

const RANK: Record<VehicleClass, number> = {
  SEDAN: 0,
  SUV: 1,
  VAN: 2,
  SPRINTER: 3,
};

const WORDS: [RegExp, VehicleClass][] = [
  // Sprinter before van: "executive sprinter van" is a Sprinter, and reading it
  // as a van sends a seven-seater to collect twelve people.
  [/\bsprinter\b/i, "SPRINTER"],
  [/\b(?:mini)?van\b/i, "VAN"],
  [/\b(?:suv|escalade|suburban|navigator)\b/i, "SUV"],
  [/\b(?:sedan|saloon|town\s*car)\b/i, "SEDAN"],
];

/**
 * The class a free-text request names, or null.
 *
 * Null rather than a guess: "something comfortable" is not a vehicle class,
 * and defaulting it to a sedan would quietly commit the cheapest car to a
 * customer who may have meant the largest.
 */
export function vehicleClassFromText(text: string | null | undefined): VehicleClass | null {
  if (!text) return null;
  for (const [pattern, cls] of WORDS) if (pattern.test(text)) return cls;
  return null;
}

/**
 * The smallest class that actually fits, or null when we know neither number.
 *
 * A missing count is not zero. Somebody who told us four suitcases and nothing
 * about passengers still needs a car with a boot, so each number is checked on
 * its own and whichever demands more wins.
 */
export function vehicleClassForLoad(
  passengers: number | null | undefined,
  bags: number | null | undefined
): VehicleClass | null {
  if (passengers == null && bags == null) return null;
  const fits = CLASSES_BY_SIZE.find(
    (cls) =>
      (passengers ?? 0) <= CAPACITY[cls].passengers && (bags ?? 0) <= CAPACITY[cls].bags
  );
  // More people than the largest car holds is a coach booking, not a car one.
  // Saying so is better than silently offering the biggest thing we have.
  return fits ?? null;
}

/**
 * True when the party fits in nothing we run.
 *
 * `vehicleClassForLoad` answers null both for this and for "we were not told",
 * which are very different things — so the two are asked separately rather
 * than left for the caller to guess between.
 */
export function exceedsEveryClass(
  passengers: number | null | undefined,
  bags: number | null | undefined
): boolean {
  if (passengers == null && bags == null) return false;
  const largest = CLASSES_BY_SIZE[CLASSES_BY_SIZE.length - 1];
  return (
    (passengers ?? 0) > CAPACITY[largest].passengers || (bags ?? 0) > CAPACITY[largest].bags
  );
}

/**
 * What to put on the booking: big enough for the party, and never smaller than
 * what they asked for.
 */
export function vehicleClassFor(input: {
  passengerCount?: number | null;
  luggageCount?: number | null;
  requested?: string | null;
}): VehicleClass | null {
  // Twelve people who wrote "sprinter" still do not fit in a Sprinter. Taking
  // the word at face value here would stamp a class on a booking no single
  // car can cover, and it would look settled to whoever reviews it.
  if (exceedsEveryClass(input.passengerCount, input.luggageCount)) return null;

  const needed = vehicleClassForLoad(input.passengerCount, input.luggageCount);
  const asked = vehicleClassFromText(input.requested);

  if (needed && asked) return RANK[asked] > RANK[needed] ? asked : needed;
  return needed ?? asked;
}

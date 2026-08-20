// Working out when the car has to collect the passenger.
//
// This is deliberately plain TypeScript with no model involved. Getting it
// wrong means somebody misses an international flight, so it needs to be
// arithmetic we can read and test, not something a language model produced
// that happened to look right. Adam only writes prose around these numbers.
//
// The rule, as the business states it:
//   - Domestic departure: be at the airport 2 hours before the flight.
//   - International departure: 3 hours before.
//   - Each stop whose duration isn't stated costs an extra 15 minutes.
//   - Work backwards from that through the drive time to get the pickup time.

import { DateTime } from "luxon";

/** Everything the company operates in, and every time the customer writes. */
export const OPERATING_TIME_ZONE = "America/New_York";

export const DOMESTIC_LEAD_MINUTES = 120;
export const INTERNATIONAL_LEAD_MINUTES = 180;

/** What we allow for a stop the customer didn't put a duration on. */
export const DEFAULT_STOP_MINUTES = 15;

/** Pickup times are rounded down to a tidy number so they read naturally. */
const ROUND_DOWN_TO_MINUTES = 5;

export type FlightKind = "DOMESTIC" | "INTERNATIONAL";

export interface PickupPlanInput {
  /** Local wall-clock the customer asked for, e.g. "2026-09-22T09:00". */
  requestedPickupLocal: string | null;
  /** Local wall-clock of the flight, when the drop-off is a departure. */
  flightDepartsLocal: string | null;
  flightKind: FlightKind | null;
  /** Driving time for the whole journey from Google, excluding stop dwell time. */
  driveMinutes: number | null;
  /**
   * One entry per intermediate stop: the stated dwell time in minutes, or null
   * when the customer didn't say (which costs DEFAULT_STOP_MINUTES).
   */
  stopDurationsMinutes?: (number | null)[];
  /**
   * Extra slack on top of the stated rule. Zero by default: the business rule
   * is 2h/3h plus drive time, and quietly padding it would misrepresent it.
   */
  bufferMinutes?: number;
}

export interface PickupPlan {
  /** When the car should collect, local wall-clock. Null if not computable. */
  recommendedPickupLocal: string | null;
  /** When they must be at the airport, local wall-clock. */
  mustArriveAtLocal: string | null;
  leadMinutes: number | null;
  stopAllowanceMinutes: number;
  driveMinutes: number | null;
  /** True when the time the customer asked for would not get them there. */
  requestedIsTooLate: boolean;
  /** How much later than recommended the requested time is, in minutes. */
  shortfallMinutes: number | null;
  /**
   * Plain-language names of the facts we'd need to finish the calculation.
   * These become the questions Adam asks.
   */
  missing: string[];
}

function parseLocal(value: string | null | undefined): DateTime | null {
  if (!value) return null;
  const dt = DateTime.fromISO(value, { zone: OPERATING_TIME_ZONE });
  return dt.isValid ? dt : null;
}

function formatLocal(dt: DateTime | null): string | null {
  return dt ? dt.toFormat("yyyy-MM-dd'T'HH:mm") : null;
}

/** Round down so a rounded pickup time is never later than the computed one. */
function roundDown(dt: DateTime): DateTime {
  const remainder = dt.minute % ROUND_DOWN_TO_MINUTES;
  return dt.minus({ minutes: remainder }).set({ second: 0, millisecond: 0 });
}

export function leadMinutesFor(kind: FlightKind): number {
  return kind === "INTERNATIONAL" ? INTERNATIONAL_LEAD_MINUTES : DOMESTIC_LEAD_MINUTES;
}

/**
 * Total dwell time to allow for stops. A stop with no stated duration costs
 * the default allowance; a stated one is taken at its word.
 */
export function stopAllowance(stops: (number | null)[] = []): number {
  return stops.reduce<number>((total, stated) => {
    if (stated === null || stated === undefined || !Number.isFinite(stated) || stated < 0) {
      return total + DEFAULT_STOP_MINUTES;
    }
    return total + stated;
  }, 0);
}

export function planPickup(input: PickupPlanInput): PickupPlan {
  const stops = input.stopDurationsMinutes ?? [];
  const stopAllowanceMinutes = stopAllowance(stops);
  const buffer = input.bufferMinutes ?? 0;

  const requested = parseLocal(input.requestedPickupLocal);
  const departs = parseLocal(input.flightDepartsLocal);
  const driveMinutes =
    typeof input.driveMinutes === "number" && Number.isFinite(input.driveMinutes) && input.driveMinutes >= 0
      ? input.driveMinutes
      : null;

  const missing: string[] = [];
  if (!departs) missing.push("the flight departure time");
  if (departs && !input.flightKind) missing.push("whether the flight is domestic or international");
  if (driveMinutes === null) missing.push("a verified pickup and drop-off address to measure the drive");

  // Not an airport departure, or not enough to work with: nothing to recommend.
  if (!departs || !input.flightKind || driveMinutes === null) {
    return {
      recommendedPickupLocal: null,
      mustArriveAtLocal: formatLocal(departs && input.flightKind ? departs.minus({ minutes: leadMinutesFor(input.flightKind) }) : null),
      leadMinutes: input.flightKind ? leadMinutesFor(input.flightKind) : null,
      stopAllowanceMinutes,
      driveMinutes,
      requestedIsTooLate: false,
      shortfallMinutes: null,
      missing,
    };
  }

  const leadMinutes = leadMinutesFor(input.flightKind);
  const mustArriveAt = departs.minus({ minutes: leadMinutes });
  const recommended = roundDown(
    mustArriveAt.minus({ minutes: driveMinutes + stopAllowanceMinutes + buffer })
  );

  // A requested time LATER than the recommended one means they'd be late.
  const shortfallMinutes = requested
    ? Math.round(requested.diff(recommended, "minutes").minutes)
    : null;

  return {
    recommendedPickupLocal: formatLocal(recommended),
    mustArriveAtLocal: formatLocal(mustArriveAt),
    leadMinutes,
    stopAllowanceMinutes,
    driveMinutes,
    requestedIsTooLate: shortfallMinutes !== null && shortfallMinutes > 0,
    shortfallMinutes,
    missing,
  };
}

/** "2026-09-22T05:40" → "Tuesday 22 September, 5:40 AM" for use in an email. */
export function describeLocal(value: string | null): string | null {
  const dt = parseLocal(value);
  return dt ? dt.toFormat("cccc d LLLL, h:mm a") : null;
}

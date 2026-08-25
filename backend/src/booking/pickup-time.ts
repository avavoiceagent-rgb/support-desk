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

/**
 * Traffic cushion on every airport run, on top of Google's drive time.
 *
 * There was none, and the Newark booking on 25 August is why there is now.
 * The flight left at 4:20 PM, domestic check-in closed at 2:20 PM, Google said
 * the drive was 16 minutes, and the pickup came out at 2:00 PM — four minutes
 * of slack, and only because the time rounds down to five. Google's number is
 * one estimate of one journey on one day. One incident on the turnpike and
 * that passenger misses their flight.
 *
 * Fifteen minutes, which Amar chose. Early costs a wait in an airport; late
 * costs the flight, and the two are not comparable.
 */
export const TRAFFIC_CUSHION_MINUTES = 15;

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
   * Extra slack on top of the stated rule.
   *
   * Defaults to TRAFFIC_CUSHION_MINUTES rather than zero. It was zero, on the
   * reasoning that padding the rule would misrepresent it — but the rule was
   * never "leave at Google's estimate", it was "be at the airport in time",
   * and a drive time with no cushion does not deliver it. Pass 0 explicitly
   * to work out the bare arithmetic.
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
  /**
   * The traffic cushion this plan used, so the draft can explain it.
   *
   * A customer who asked for 2:00 PM and is offered 1:45 PM deserves to know
   * the extra quarter hour is deliberate. Unexplained, it reads as the desk
   * being careless with their afternoon.
   */
  bufferMinutes: number;
  /** True when the time the customer asked for would not get them there. */
  requestedIsTooLate: boolean;
  /** How much later than recommended the requested time is, in minutes. */
  shortfallMinutes: number | null;
  /**
   * Plain-language names of the facts we'd need to finish the calculation.
   * These become the questions Adam asks.
   */
  missing: string[];
  /**
   * Both answers, for when the only thing missing is which rule applies.
   *
   * Domestic and international differ by exactly one hour of lead time. When
   * we know the flight time and the drive but not which kind of flight it is,
   * every ingredient of both answers is already in hand — so the customer can
   * be told what each would mean instead of being asked an open question and
   * left to work out the consequence themselves.
   *
   * Null whenever the choice is not open: either the kind is known, or
   * something else is missing and there is nothing to offer.
   */
  ifDomesticLocal: string | null;
  ifInternationalLocal: string | null;
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
  const buffer = input.bufferMinutes ?? TRAFFIC_CUSHION_MINUTES;

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

  /** The pickup that satisfies one rule, given everything else. */
  const pickupUnder = (kind: FlightKind, at: DateTime, drive: number): DateTime =>
    roundDown(
      at.minus({ minutes: leadMinutesFor(kind) }).minus({
        minutes: drive + stopAllowanceMinutes + buffer,
      })
    );

  // Not an airport departure, or not enough to work with: nothing to recommend.
  if (!departs || !input.flightKind || driveMinutes === null) {
    // One exception, and it is the common one: the flight time and the drive
    // are known and only the kind of flight is not. Both answers exist, so
    // both are offered rather than neither.
    const choiceIsOpen = Boolean(departs) && !input.flightKind && driveMinutes !== null;

    return {
      recommendedPickupLocal: null,
      mustArriveAtLocal: formatLocal(departs && input.flightKind ? departs.minus({ minutes: leadMinutesFor(input.flightKind) }) : null),
      leadMinutes: input.flightKind ? leadMinutesFor(input.flightKind) : null,
      stopAllowanceMinutes,
      driveMinutes,
      bufferMinutes: buffer,
      requestedIsTooLate: false,
      shortfallMinutes: null,
      missing,
      ifDomesticLocal: choiceIsOpen ? formatLocal(pickupUnder("DOMESTIC", departs!, driveMinutes!)) : null,
      ifInternationalLocal: choiceIsOpen
        ? formatLocal(pickupUnder("INTERNATIONAL", departs!, driveMinutes!))
        : null,
    };
  }

  const leadMinutes = leadMinutesFor(input.flightKind);
  const mustArriveAt = departs.minus({ minutes: leadMinutes });
  const recommended = pickupUnder(input.flightKind, departs, driveMinutes);

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
    bufferMinutes: buffer,
    requestedIsTooLate: shortfallMinutes !== null && shortfallMinutes > 0,
    shortfallMinutes,
    missing,
    // The choice is settled, so there is nothing to offer.
    ifDomesticLocal: null,
    ifInternationalLocal: null,
  };
}

/** "2026-09-22T05:40" → "Tuesday 22 September, 5:40 AM" for use in an email. */
export function describeLocal(value: string | null): string | null {
  const dt = parseLocal(value);
  return dt ? dt.toFormat("cccc d LLLL, h:mm a") : null;
}

/**
 * Just the clock time: "3:05 PM".
 *
 * For the second of two times on the same day, where repeating the date reads
 * as though it might be a different one.
 */
export function describeTimeLocal(value: string | null): string | null {
  const dt = parseLocal(value);
  return dt ? dt.toFormat("h:mm a") : null;
}

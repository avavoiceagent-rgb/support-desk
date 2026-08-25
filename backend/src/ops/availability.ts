// Who can actually take this trip.
//
// Every answer here is a database query, not a judgement. "Is Marco free at
// 3pm on the 24th" has one correct answer, and a model asked to guess would
// sound exactly as confident when it was wrong. Adam gets told the answer; it
// never works it out.
//
// Availability is derived, never stored: a driver is free when a shift covers
// the window, the shift is not marked unavailable, and no trip of theirs
// overlaps it. A flag on the driver would be wrong the moment a trip moved.

import { and, asc, eq, gte, lte, ne, or, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { db } from "../db/client";
import { affiliates, driverShifts, drivers, trips, vehicles } from "../db/schema";
import { OPERATING_TIME_ZONE } from "../booking/pickup-time";

export type VehicleClass = "SEDAN" | "SUV" | "VAN" | "SPRINTER";

/** Milliseconds in an hour, spelled once. */
const HOUR_MS = 3_600_000;

/**
 * Does a booking collide with a window?
 *
 * The single definition of "these two overlap", used both by the availability
 * search below and by the double-booking refusal in `trips.ts`. Two versions of
 * this would eventually disagree, and the disagreement would show up as a
 * dispatcher being told a driver is free by one screen and double-booked by
 * another.
 *
 * Touching at the edges is not an overlap: a trip ending at 3pm and one
 * starting at 3pm are back to back, which is a normal day's work.
 */
export function overlapsWindow(
  tripStart: Date,
  tripHours: number,
  windowStart: Date,
  windowEnd: Date
): boolean {
  const start = tripStart.getTime();
  const end = start + tripHours * HOUR_MS;
  return start < windowEnd.getTime() && end > windowStart.getTime();
}

/** Bigger vehicles can cover a smaller booking; the reverse is not true. */
const CLASS_RANK: Record<VehicleClass, number> = { SEDAN: 1, SUV: 2, VAN: 3, SPRINTER: 4 };

export interface AvailabilityQuery {
  /** Local pickup time as a real instant. */
  pickupAt: Date;
  /** How long the car is booked for; the window we need it free. */
  hours: number;
  /** The smallest vehicle that will do. */
  vehicleClass: VehicleClass;
  /** Minutes of slack either side, for the drive to and from the job. */
  bufferMinutes?: number;
  /**
   * A trip to ignore when looking for clashes — itself.
   *
   * Without this, asking "is Amrit still free for T-10308?" answers no,
   * because T-10308 is on his list. A driver is not unavailable on account of
   * the very job being asked about, and the wrong answer here would send a
   * dispatcher hunting for a replacement nobody needed.
   */
  excludeTripId?: string;
}

export interface AvailableDriver {
  driverId: string;
  name: string;
  phone: string;
  vehicleId: string | null;
  vehicleLabel: string | null;
  vehicleClass: VehicleClass | null;
  /** Trips they already have that day — context for whoever assigns. */
  tripsThatDay: number;
}

const DEFAULT_BUFFER_MINUTES = 45;

/**
 * How far back the clash search has to reach.
 *
 * A trip that started before the window can still be in the middle of it, and
 * a booking is only found by its pickup time. Nothing here is booked for more
 * than a day; a longer one would need this raised, and the failure would be a
 * driver shown as free while they are out on it.
 */
const LONGEST_BOOKING_HOURS = 24;

/**
 * Drivers who could take this trip, in the order a dispatcher would consider
 * them: least busy first, so the work spreads.
 */
export async function findAvailableDrivers(query: AvailabilityQuery): Promise<AvailableDriver[]> {
  const buffer = (query.bufferMinutes ?? DEFAULT_BUFFER_MINUTES) * 60_000;
  const windowStart = new Date(query.pickupAt.getTime() - buffer);
  const windowEnd = new Date(query.pickupAt.getTime() + query.hours * 3_600_000 + buffer);
  const wanted = CLASS_RANK[query.vehicleClass];

  const rows = await db
    .select({
      driverId: drivers.id,
      name: drivers.name,
      phone: drivers.phone,
      vehicleId: vehicles.id,
      vehicleLabel: vehicles.label,
      vehicleClass: vehicles.class,
      shiftStart: driverShifts.startsAt,
      shiftEnd: driverShifts.endsAt,
    })
    .from(driverShifts)
    .innerJoin(drivers, eq(drivers.id, driverShifts.driverId))
    .leftJoin(vehicles, eq(vehicles.id, driverShifts.vehicleId))
    .where(
      and(
        eq(drivers.active, true),
        eq(driverShifts.unavailable, false),
        // The shift has to cover the whole window, not merely overlap it.
        lte(driverShifts.startsAt, windowStart),
        gte(driverShifts.endsAt, windowEnd)
      )
    )
    .orderBy(asc(drivers.name));

  if (rows.length === 0) return [];

  // The driver's day, not the server's.
  //
  // This used to slice the day with setUTCHours(0), which in New York is 8pm
  // the evening before. A 9pm pickup counted against the following day, so the
  // "trips that day" figure a dispatcher sorts on was for a day the driver
  // does not recognise.
  const day = DateTime.fromJSDate(query.pickupAt).setZone(OPERATING_TIME_ZONE).startOf("day");
  const dayStart = day.toJSDate();
  const dayEnd = day.plus({ days: 1 }).toJSDate();

  // One query for every trip that could clash, rather than one per driver.
  //
  // Bounded by the window we actually care about, not by the calendar day.
  // The old bounds were the pickup's day give or take one, which quietly
  // missed both ends: a late-evening pickup runs past midnight, so a clash
  // early the next morning fell outside them, and the driver came back marked
  // free. Widened at the start by the longest booking anyone takes, because a
  // trip that STARTS before the window can still be running inside it.
  const clashFrom = new Date(windowStart.getTime() - LONGEST_BOOKING_HOURS * HOUR_MS);
  const searchFrom = new Date(Math.min(clashFrom.getTime(), dayStart.getTime()));
  const searchTo = new Date(Math.max(windowEnd.getTime(), dayEnd.getTime()));

  const nearbyTrips = await db
    .select({
      id: trips.id,
      driverId: trips.driverId,
      pickupAt: trips.pickupAt,
      bookedHours: trips.bookedHours,
    })
    .from(trips)
    .where(
      and(
        gte(trips.pickupAt, searchFrom),
        lte(trips.pickupAt, searchTo),
        ne(trips.status, "CANCELLED")
      )
    );

  const clashes = new Map<string, number>();
  const dayCount = new Map<string, number>();
  for (const trip of nearbyTrips) {
    if (!trip.driverId) continue;
    if (query.excludeTripId && trip.id === query.excludeTripId) continue;
    if (trip.pickupAt >= dayStart && trip.pickupAt < dayEnd) {
      dayCount.set(trip.driverId, (dayCount.get(trip.driverId) ?? 0) + 1);
    }
    if (overlapsWindow(trip.pickupAt, trip.bookedHours, windowStart, windowEnd)) {
      clashes.set(trip.driverId, (clashes.get(trip.driverId) ?? 0) + 1);
    }
  }

  return rows
    .filter((r) => !clashes.has(r.driverId))
    .filter((r) => {
      // No vehicle on the shift means nothing to drive.
      if (!r.vehicleClass) return false;
      return CLASS_RANK[r.vehicleClass as VehicleClass] >= wanted;
    })
    .map((r) => ({
      driverId: r.driverId,
      name: r.name,
      phone: r.phone,
      vehicleId: r.vehicleId,
      vehicleLabel: r.vehicleLabel,
      vehicleClass: (r.vehicleClass as VehicleClass) ?? null,
      tripsThatDay: dayCount.get(r.driverId) ?? 0,
    }))
    .sort((a, b) => a.tripsThatDay - b.tripsThatDay || a.name.localeCompare(b.name));
}

export interface AffiliateSuggestion {
  affiliateId: string;
  company: string;
  phone: string;
  email: string;
  hourlyRateUsd: number | null;
  preference: number;
  reason: "COVERS_AREA" | "OVERFLOW";
  notes: string | null;
}

/**
 * Partners who could cover a trip we cannot.
 *
 * Two different situations, deliberately kept apart: the trip leaves our
 * service area (match on where it goes), or every one of our own cars is busy
 * (match on being an overflow partner). Confusing the two would send a
 * Manhattan job to a Miami operator.
 */
export async function suggestAffiliates(params: {
  states?: string[];
  cities?: string[];
  overflow?: boolean;
}): Promise<AffiliateSuggestion[]> {
  const rows = await db.select().from(affiliates).where(eq(affiliates.active, true));
  const states = (params.states ?? []).map((s) => s.toUpperCase());
  const cities = (params.cities ?? []).map((c) => c.toLowerCase());

  const matches = rows
    .map((a) => {
      if (params.overflow) {
        return a.overflowPartner ? { a, reason: "OVERFLOW" as const } : null;
      }
      const coversState = a.coverageStates.some((s) => states.includes(s.toUpperCase()));
      const coversCity = a.coverageCities.some((c) => cities.includes(c.toLowerCase()));
      return coversState || coversCity ? { a, reason: "COVERS_AREA" as const } : null;
    })
    .filter((m): m is { a: (typeof rows)[number]; reason: "COVERS_AREA" | "OVERFLOW" } => m !== null);

  return matches
    .sort((x, y) => x.a.preference - y.a.preference || x.a.company.localeCompare(y.a.company))
    .map(({ a, reason }) => ({
      affiliateId: a.id,
      company: a.company,
      phone: a.phone,
      email: a.email,
      hourlyRateUsd: a.hourlyRateUsd,
      preference: a.preference,
      reason,
      notes: a.notes,
    }));
}

/** True when nobody at all can take it — the moment to call a partner. */
export async function isFleetFullyCommitted(query: AvailabilityQuery): Promise<boolean> {
  const free = await findAvailableDrivers(query);
  return free.length === 0;
}

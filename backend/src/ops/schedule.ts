// One driver's day, read the way a dispatcher reads it.
//
// A list by driver, not a week grid: pick somebody, see their shifts and what
// is booked inside each one. The trips are nested in the shift that covers
// them, because that is the question being asked — "is Marco's Thursday
// full?" — and a flat list of trips beside a flat list of shifts leaves the
// reader to do the join by eye.

import { and, asc, eq, gte, lte, ne } from "drizzle-orm";
import { db } from "../db/client";
import { driverShifts, drivers, trips, vehicles } from "../db/schema";
import { selectTrips, toTripRecord, type TripRecord } from "./lookup";
import { OpsError } from "./errors";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** A shift longer than this is a typo, not a working day. */
export const MAX_SHIFT_HOURS = 24;

/** How much of the schedule to show when the caller does not say. */
const DEFAULT_WINDOW_DAYS = 14;

export interface ScheduleShift {
  id: string;
  startsAt: Date;
  endsAt: Date;
  unavailable: boolean;
  reason: string | null;
  vehicle: { id: string; label: string; class: string } | null;
  trips: TripRecord[];
}

export interface DriverSchedule {
  driver: typeof drivers.$inferSelect;
  shifts: ScheduleShift[];
  /**
   * Trips assigned to this driver that no shift covers.
   *
   * Never dropped, never quietly folded into the nearest shift. A trip nobody
   * is rostered for is a real dispatch problem, and a screen that hides it is
   * telling the dispatcher a comfortable lie.
   */
  unscheduledTrips: TripRecord[];
}

export interface ScheduleWindow {
  from?: Date;
  to?: Date;
}

/** The window to read, with sane defaults and the range checked. */
export function resolveWindow(window: ScheduleWindow, now = new Date()): { from: Date; to: Date } {
  const from = window.from ?? new Date(now.getTime());
  const to = window.to ?? new Date(from.getTime() + DEFAULT_WINDOW_DAYS * DAY_MS);
  if (to.getTime() <= from.getTime()) {
    throw new OpsError("The end of the range must be after the start.");
  }
  return { from, to };
}

export async function getDriverSchedule(
  driverId: string,
  window: ScheduleWindow = {}
): Promise<DriverSchedule | null> {
  const [driver] = await db.select().from(drivers).where(eq(drivers.id, driverId)).limit(1);
  if (!driver) return null;

  const { from, to } = resolveWindow(window);

  const shiftRows = await db
    .select({
      id: driverShifts.id,
      startsAt: driverShifts.startsAt,
      endsAt: driverShifts.endsAt,
      unavailable: driverShifts.unavailable,
      reason: driverShifts.reason,
      vehicleId: vehicles.id,
      vehicleLabel: vehicles.label,
      vehicleClass: vehicles.class,
    })
    .from(driverShifts)
    .leftJoin(vehicles, eq(vehicles.id, driverShifts.vehicleId))
    .where(
      and(
        eq(driverShifts.driverId, driverId),
        // Any shift that reaches into the window, not only ones inside it.
        lte(driverShifts.startsAt, to),
        gte(driverShifts.endsAt, from)
      )
    )
    .orderBy(asc(driverShifts.startsAt));

  const tripRows = await selectTrips()
    .where(and(eq(trips.driverId, driverId), gte(trips.pickupAt, from), lte(trips.pickupAt, to)))
    .orderBy(asc(trips.pickupAt));
  const driverTrips = tripRows.map(toTripRecord);

  const shifts: ScheduleShift[] = shiftRows.map((s) => ({
    id: s.id,
    startsAt: s.startsAt,
    endsAt: s.endsAt,
    unavailable: s.unavailable,
    reason: s.reason,
    vehicle:
      s.vehicleId && s.vehicleLabel && s.vehicleClass
        ? { id: s.vehicleId, label: s.vehicleLabel, class: s.vehicleClass }
        : null,
    trips: [],
  }));

  const unscheduledTrips: TripRecord[] = [];
  for (const trip of driverTrips) {
    // Covered means covered end to end. A trip that starts inside a shift and
    // runs past the end of it is exactly the case worth surfacing, so partial
    // cover counts as no cover rather than being rounded down to "fine".
    const tripStart = trip.pickupAt.getTime();
    const tripEnd = tripStart + trip.bookedHours * HOUR_MS;
    const covering = shifts.find(
      (s) => s.startsAt.getTime() <= tripStart && s.endsAt.getTime() >= tripEnd
    );
    if (covering) covering.trips.push(trip);
    else unscheduledTrips.push(trip);
  }

  return { driver, shifts, unscheduledTrips };
}

export interface ShiftInput {
  driverId: string;
  vehicleId?: string | null;
  startsAt: Date;
  endsAt: Date;
  unavailable?: boolean;
  reason?: string | null;
}

/**
 * The rules a shift has to satisfy, checked in one place so create and update
 * cannot drift apart. `existing` is the row being patched, if any.
 */
async function assertShiftIsSane(input: {
  driverId?: string;
  vehicleId?: string | null;
  startsAt: Date;
  endsAt: Date;
}) {
  if (input.endsAt.getTime() <= input.startsAt.getTime()) {
    throw new OpsError("A shift has to end after it starts.");
  }
  const hours = (input.endsAt.getTime() - input.startsAt.getTime()) / HOUR_MS;
  if (hours > MAX_SHIFT_HOURS) {
    throw new OpsError(
      `That shift is ${hours.toFixed(1)} hours long. The longest a shift can be is ${MAX_SHIFT_HOURS} hours — check the dates.`
    );
  }
  if (input.driverId) {
    const [driver] = await db.select().from(drivers).where(eq(drivers.id, input.driverId)).limit(1);
    if (!driver) throw new OpsError(`No driver with id ${input.driverId}.`, 404);
  }
  if (input.vehicleId) {
    const [vehicle] = await db
      .select()
      .from(vehicles)
      .where(eq(vehicles.id, input.vehicleId))
      .limit(1);
    if (!vehicle) throw new OpsError(`No vehicle with id ${input.vehicleId}.`, 404);
  }
}

export async function createShift(input: ShiftInput) {
  await assertShiftIsSane(input);
  const [row] = await db
    .insert(driverShifts)
    .values({
      driverId: input.driverId,
      vehicleId: input.vehicleId ?? null,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      unavailable: input.unavailable ?? false,
      reason: input.reason ?? null,
    })
    .returning();
  return row;
}

export async function updateShift(id: string, patch: Partial<ShiftInput>) {
  const [existing] = await db.select().from(driverShifts).where(eq(driverShifts.id, id)).limit(1);
  if (!existing) throw new OpsError(`No shift with id ${id}.`, 404);

  // Validate the shift as it will be, not as it was: patching only the end
  // still has to leave a shift that makes sense against the existing start.
  await assertShiftIsSane({
    driverId: patch.driverId,
    vehicleId: patch.vehicleId,
    startsAt: patch.startsAt ?? existing.startsAt,
    endsAt: patch.endsAt ?? existing.endsAt,
  });

  const [row] = await db
    .update(driverShifts)
    .set(patch)
    .where(eq(driverShifts.id, id))
    .returning();
  return row;
}

/**
 * Shifts are the one thing here that really is deleted.
 *
 * Nothing points at a shift — availability is recomputed from whatever shifts
 * exist right now — so removing one rosters somebody off and leaves no hole.
 * Drivers, vehicles and affiliates are deactivated instead; see directory.ts.
 */
export async function deleteShift(id: string) {
  const [row] = await db.delete(driverShifts).where(eq(driverShifts.id, id)).returning();
  if (!row) throw new OpsError(`No shift with id ${id}.`, 404);
  return row;
}

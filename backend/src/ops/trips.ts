// Looking through the reservations, and changing one.
//
// The read half is a filtered list for a person browsing. The write half is
// where the only real business rule in this file lives: a driver cannot be in
// two places at once, and the desk refuses rather than letting a dispatcher
// find out on the day.

import { and, asc, count, desc, eq, gte, lte, ne, or, sql, type SQL } from "drizzle-orm";
import { DateTime } from "luxon";
import { db } from "../db/client";
import { affiliates, drivers, trips, vehicles } from "../db/schema";
import { overlapsWindow } from "./availability";
import { selectTrips, toTripRecord, type TripRecord } from "./lookup";
import { diffTrip, recordTripEvent, type Actor } from "./trip-events";
import { OpsError } from "./errors";
import { OPERATING_TIME_ZONE } from "../booking/pickup-time";

const HOUR_MS = 3_600_000;

export const DEFAULT_TRIP_LIMIT = 50;
export const MAX_TRIP_LIMIT = 200;

/**
 * Columns the reservations table can be ordered by.
 *
 * A whitelist rather than a column name off the wire, and it exists at all
 * because the alternative is worse than untidy: sorting the fifty rows the
 * screen happens to be holding would put "Aaron" at the top of a page drawn
 * from the middle of three hundred bookings and call it alphabetical. Sorting
 * belongs where the whole result set is.
 */
export const TRIP_SORTS = {
  pickupAt: trips.pickupAt,
  reference: trips.reference,
  passengerName: trips.passengerName,
  bookedHours: trips.bookedHours,
  status: trips.status,
  driver: drivers.name,
  vehicle: vehicles.label,
} as const;

export type TripSort = keyof typeof TRIP_SORTS;

export interface TripSearch {
  from?: Date;
  to?: Date;
  status?: string;
  driverId?: string;
  affiliateId?: string;
  /** Free text over the reference, passenger name and booker email. */
  q?: string;
  sort?: TripSort;
  dir?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

export interface TripSearchResult {
  trips: TripRecord[];
  /** Matches before paging, so the screen can show "1-50 of 312". */
  total: number;
}

function searchFilters(search: TripSearch): SQL[] {
  const filters: SQL[] = [];
  if (search.from) filters.push(gte(trips.pickupAt, search.from));
  if (search.to) filters.push(lte(trips.pickupAt, search.to));
  if (search.status) filters.push(sql`${trips.status} = ${search.status}`);
  if (search.driverId) filters.push(eq(trips.driverId, search.driverId));
  if (search.affiliateId) filters.push(eq(trips.affiliateId, search.affiliateId));

  const q = search.q?.trim();
  if (q) {
    // Case-insensitive contains. People search "costa", "ana@", "10432" and
    // expect all three to work, so the reference is matched loosely here
    // rather than through the strict reference parser — this is a search box,
    // not a customer quoting a booking.
    const like = `%${q.toLowerCase()}%`;
    filters.push(
      or(
        sql`lower(${trips.reference}) like ${like}`,
        sql`lower(${trips.passengerName}) like ${like}`,
        sql`lower(coalesce(${trips.bookerEmail}, '')) like ${like}`
      )!
    );
  }
  return filters;
}

/**
 * Reservations matching the filters, newest pickup first.
 *
 * Newest first because the screen opens on "what happened lately"; a caller
 * wanting a diary reads a date range and can order it themselves. Cancelled
 * trips are included — they are exactly what somebody browsing for a billing
 * dispute is looking for.
 */
export async function searchTrips(search: TripSearch = {}): Promise<TripSearchResult> {
  const limit = Math.min(Math.max(search.limit ?? DEFAULT_TRIP_LIMIT, 1), MAX_TRIP_LIMIT);
  const offset = Math.max(search.offset ?? 0, 0);
  const filters = searchFilters(search);
  const where = filters.length ? and(...filters) : undefined;

  const column = TRIP_SORTS[search.sort ?? "pickupAt"];
  const direction = search.dir === "asc" ? asc : desc;
  // Reference last, always. Sorting by driver puts every one of Marco's trips
  // together but says nothing about their order within that block, and a list
  // that reshuffles under the reader between two identical queries is its own
  // small bug.
  const order =
    column === trips.reference
      ? [direction(column)]
      : [direction(column), desc(trips.pickupAt), asc(trips.reference)];

  const [rows, [totals]] = await Promise.all([
    selectTrips().where(where).orderBy(...order).limit(limit).offset(offset),
    db.select({ value: count() }).from(trips).where(where),
  ]);

  return { trips: rows.map(toTripRecord), total: Number(totals?.value ?? 0) };
}

export interface TripPatch {
  pickupAt?: Date;
  bookedHours?: number;
  driverId?: string | null;
  vehicleId?: string | null;
  affiliateId?: string | null;
  status?: string;
  notes?: string | null;
}

export interface TripClash {
  id: string;
  reference: string;
  pickupAt: Date;
  bookedHours: number;
}

/**
 * Other trips this driver already has across the same hours.
 *
 * Deliberately without the travel buffer that `findAvailableDrivers` applies.
 * That buffer is there to *suggest* well — it keeps a suggestion from putting
 * somebody on the far side of the city with twenty minutes to cross it. This
 * is a *refusal*, and refusing a tight-but-possible turnaround that a
 * dispatcher has chosen on purpose would be the code overruling the person who
 * can see the road. Genuine overlap only.
 */
export async function findDriverClashes(params: {
  driverId: string;
  pickupAt: Date;
  hours: number;
  excludeTripId?: string;
}): Promise<TripClash[]> {
  const windowStart = params.pickupAt;
  const windowEnd = new Date(params.pickupAt.getTime() + params.hours * HOUR_MS);

  // Two days either side, so the scan stays off the whole table while still
  // catching a long booking that starts well before this window and runs into
  // it. `bookedHours` has no ceiling, so one day was not quite enough.
  const rows = await db
    .select({
      id: trips.id,
      reference: trips.reference,
      pickupAt: trips.pickupAt,
      bookedHours: trips.bookedHours,
    })
    .from(trips)
    .where(
      and(
        eq(trips.driverId, params.driverId),
        // A cancelled trip holds nobody's time.
        ne(trips.status, "CANCELLED"),
        gte(trips.pickupAt, new Date(windowStart.getTime() - 2 * 86_400_000)),
        lte(trips.pickupAt, new Date(windowEnd.getTime() + 2 * 86_400_000))
      )
    )
    .orderBy(asc(trips.pickupAt));

  return rows.filter(
    (r) =>
      r.id !== params.excludeTripId &&
      overlapsWindow(r.pickupAt, r.bookedHours, windowStart, windowEnd)
  );
}

/**
 * The clash, written the way the dispatcher reading it thinks about time.
 *
 * Local, not UTC. Somebody in Newark being told "10:00-13:00 UTC" has to do
 * arithmetic before they can act, and the whole point of this message is that
 * it can be acted on without stopping to think.
 */
function describeClash(clash: TripClash): string {
  const start = DateTime.fromJSDate(clash.pickupAt).setZone(OPERATING_TIME_ZONE);
  const end = start.plus({ hours: clash.bookedHours });
  return `${clash.reference} (${start.toFormat("d LLL, HH:mm")}–${end.toFormat("HH:mm")})`;
}

/**
 * Change a reservation.
 *
 * The double-booking check runs against the trip as it will be, not as it is:
 * moving the pickup time of an already-assigned trip can create a clash just
 * as assigning a driver can.
 */
export async function updateTrip(id: string, patch: TripPatch, actor?: Actor): Promise<TripRecord> {
  // Read the joined record, not the bare row: the audit trail wants to say
  // "Marco Rinaldi", and it can only do that if it knew the name before the
  // change as well as after.
  const [before] = await selectTrips().where(eq(trips.id, id)).limit(1);
  if (!before) throw new OpsError(`No trip with id ${id}.`, 404);
  const existing = before.trip;

  const driverId = patch.driverId === undefined ? existing.driverId : patch.driverId;
  const pickupAt = patch.pickupAt ?? existing.pickupAt;
  const bookedHours = patch.bookedHours ?? existing.bookedHours;
  const status = patch.status ?? existing.status;

  if (patch.driverId) {
    const [driver] = await db.select().from(drivers).where(eq(drivers.id, patch.driverId)).limit(1);
    if (!driver) throw new OpsError(`No driver with id ${patch.driverId}.`, 404);
    if (!driver.active) {
      throw new OpsError(`${driver.name} is deactivated and cannot take new work.`);
    }
  }
  if (patch.vehicleId) {
    const [vehicle] = await db.select().from(vehicles).where(eq(vehicles.id, patch.vehicleId)).limit(1);
    if (!vehicle) throw new OpsError(`No vehicle with id ${patch.vehicleId}.`, 404);
  }
  if (patch.affiliateId) {
    const [affiliate] = await db
      .select()
      .from(affiliates)
      .where(eq(affiliates.id, patch.affiliateId))
      .limit(1);
    if (!affiliate) throw new OpsError(`No affiliate with id ${patch.affiliateId}.`, 404);
  }

  // A cancelled trip occupies nobody, so there is nothing to clash with.
  if (driverId && status !== "CANCELLED") {
    const clashes = await findDriverClashes({ driverId, pickupAt, hours: bookedHours, excludeTripId: id });
    if (clashes.length > 0) {
      const [driver] = await db.select().from(drivers).where(eq(drivers.id, driverId)).limit(1);
      const who = driver?.name ?? "That driver";
      throw new OpsError(
        `${who} is already on ${clashes.map(describeClash).join(" and ")}. Move or reassign that first.`,
        409
      );
    }
  }

  // `assignedKind` follows from who is actually on the job rather than being
  // set by hand. It was drifting: assigning a driver from the Reservations
  // screen left a trip reading UNASSIGNED with a driver's name beside it,
  // because nothing on that path ever touched the column. Derived, it cannot.
  const affiliateId = patch.affiliateId === undefined ? existing.affiliateId : patch.affiliateId;
  const assignedKind = driverId ? "DRIVER" : affiliateId ? "AFFILIATE" : "UNASSIGNED";

  const [row] = await db
    .update(trips)
    .set({ ...patch, assignedKind, updatedAt: new Date() } as Partial<typeof trips.$inferInsert>)
    .where(eq(trips.id, id))
    .returning();

  const found = await selectTrips().where(eq(trips.id, row.id)).limit(1);
  const after = toTripRecord(found[0]);

  // Recorded after the write succeeds, so a refused change leaves no trace of
  // having happened. An actor is optional only so the seed and the tests can
  // build fixtures without inventing a person who did it.
  if (actor) {
    await recordTripEvent({
      tripId: id,
      actor,
      kind: after.status === "CANCELLED" && before.trip.status !== "CANCELLED" ? "CANCELLED" : "UPDATED",
      changes: diffTrip(toTripRecord(before), after),
    });
  }

  return after;
}

// Who changed a reservation, and what they changed.
//
// Written in words at the moment the change happens, not reconstructed later
// from ids. "Driver: unassigned → Marco Rinaldi" is readable by the person who
// needs it, six weeks on, while looking at a customer complaint. A row id is
// not, and by then the driver may have been deactivated and dropped out of
// every list the reader could use to look it up.
//
// Append-only. Nothing here is ever updated or deleted, because an audit trail
// that can be tidied afterwards is not evidence of anything.

import { asc, eq } from "drizzle-orm";
import { DateTime } from "luxon";
import { db } from "../db/client";
import { tripEvents, users } from "../db/schema";
import { OPERATING_TIME_ZONE } from "../booking/pickup-time";
import type { TripRecord } from "./lookup";

export type TripEvent = typeof tripEvents.$inferSelect;
export interface FieldChange {
  field: string;
  from: string | null;
  to: string | null;
}

/** The desk itself, for anything no person pressed. */
const SYSTEM_ACTOR = "Support Desk";

const STATUS_WORDS: Record<string, string> = {
  SCHEDULED: "Scheduled",
  IN_PROGRESS: "On the road",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
  NO_SHOW: "No show",
};

/** New York, like every other time this system shows a person. */
function whenLocal(at: Date): string {
  return DateTime.fromJSDate(at).setZone(OPERATING_TIME_ZONE).toFormat("d LLL yyyy, h:mm a");
}

/**
 * The fields worth recording, each already turned into something readable.
 *
 * Deliberately not every column. `updatedAt` changes on every write and would
 * bury the one line somebody is looking for, and the addresses and passenger
 * name are not editable from any screen, so a change to them would mean
 * something has gone wrong rather than somebody did something.
 */
function readable(trip: TripRecord): Record<string, string | null> {
  return {
    Pickup: whenLocal(trip.pickupAt),
    "Hours booked": String(trip.bookedHours),
    Status: STATUS_WORDS[trip.status] ?? trip.status,
    Driver: trip.driver?.name ?? "Unassigned",
    Car: trip.vehicle?.label ?? "None",
    Partner: trip.affiliate?.company ?? "None",
    Notes: trip.notes ?? null,
  };
}

/** What actually moved between two versions of a trip. */
export function diffTrip(before: TripRecord, after: TripRecord): FieldChange[] {
  const a = readable(before);
  const b = readable(after);
  const changes: FieldChange[] = [];
  for (const field of Object.keys(a)) {
    if (a[field] !== b[field]) changes.push({ field, from: a[field], to: b[field] });
  }
  return changes;
}

export interface Actor {
  userId: string | null;
  name: string;
}

/** The name to record for a user id, snapshotted as it is right now. */
export async function actorFor(userId: string | undefined): Promise<Actor> {
  if (!userId) return { userId: null, name: SYSTEM_ACTOR };
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  return { userId: user?.id ?? null, name: user?.name ?? SYSTEM_ACTOR };
}

export async function recordTripEvent(
  params: {
    tripId: string;
    actor: Actor;
    kind: "CREATED" | "UPDATED" | "CANCELLED";
    changes?: FieldChange[];
    source?: string | null;
  },
  /** Pass the transaction so the change and its record stand or fall together. */
  client: Pick<typeof db, "insert"> = db
): Promise<TripEvent | null> {
  // An update that changed nothing is not history. Someone opening the editor
  // and pressing Save should not leave a footprint suggesting they did.
  if (params.kind === "UPDATED" && (params.changes ?? []).length === 0) return null;

  const [row] = await client
    .insert(tripEvents)
    .values({
      tripId: params.tripId,
      actorUserId: params.actor.userId,
      actorName: params.actor.name,
      kind: params.kind,
      changes: params.changes ?? [],
      source: params.source ?? null,
    })
    .returning();
  return row;
}

/**
 * Oldest first: a history is read forwards.
 *
 * The id breaks a tie. Two events written in the same millisecond had no
 * defined order, so a history could read differently on two loads — which in
 * an audit trail is worse than it sounds, because the whole value of one is
 * that it says the same thing every time somebody looks.
 */
export async function listTripEvents(tripId: string): Promise<TripEvent[]> {
  return db
    .select()
    .from(tripEvents)
    .where(eq(tripEvents.tripId, tripId))
    .orderBy(asc(tripEvents.createdAt), asc(tripEvents.id));
}

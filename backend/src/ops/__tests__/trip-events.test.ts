import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { db, pool } from "../../db/client";
import {
  affiliates, driverShifts, drivers, invoiceLines, invoices, tripEvents, trips, users, vehicles,
} from "../../db/schema";
import { updateTrip } from "../trips";
import { actorFor, diffTrip, listTripEvents, recordTripEvent } from "../trip-events";
import { selectTrips, toTripRecord } from "../lookup";
import { eq } from "drizzle-orm";

const NOW = new Date("2026-09-22T14:00:00.000Z");
const at = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000);

afterAll(async () => {
  await pool.end();
});

async function reset() {
  await db.delete(tripEvents);
  await db.delete(invoiceLines);
  await db.delete(invoices);
  await db.delete(trips);
  await db.delete(driverShifts);
  await db.delete(drivers);
  await db.delete(affiliates);
  await db.delete(vehicles);
  await db.delete(users);
}

async function makeUser(name = "Amar Pant") {
  const [u] = await db
    .insert(users)
    .values({ name, email: `${name.split(" ")[0].toLowerCase()}@desk.example`, passwordHash: "x", role: "ADMIN" })
    .returning();
  return u;
}

async function makeTrip() {
  const [t] = await db
    .insert(trips)
    .values({
      reference: "T-10432",
      passengerName: "Ana Costa",
      pickupAddress: "230 Park Ave",
      dropoffAddress: "JFK Terminal 4",
      pickupAt: at(10),
      bookedHours: 2,
      vehicleClass: "SEDAN",
    })
    .returning();
  return t;
}

async function record(id: string) {
  const rows = await selectTrips().where(eq(trips.id, id)).limit(1);
  return toTripRecord(rows[0]);
}

describe("diffTrip", () => {
  it("names the driver rather than the row id", async () => {
    await reset();
    const trip = await makeTrip();
    const [driver] = await db
      .insert(drivers)
      .values({ name: "Marco Rinaldi", phone: "+1 917 555 0199" })
      .returning();

    const before = await record(trip.id);
    await db.update(trips).set({ driverId: driver.id }).where(eq(trips.id, trip.id));
    const after = await record(trip.id);

    expect(diffTrip(before, after)).toEqual([
      { field: "Driver", from: "Unassigned", to: "Marco Rinaldi" },
    ]);
  });

  it("says nothing when nothing moved", async () => {
    await reset();
    const trip = await makeTrip();
    const same = await record(trip.id);
    expect(diffTrip(same, same)).toEqual([]);
  });

  it("ignores columns no screen can change", async () => {
    await reset();
    const trip = await makeTrip();
    const before = await record(trip.id);
    // updatedAt moves on every write; if it were recorded, every entry would
    // carry a line nobody asked about and the real change would be buried.
    await db.update(trips).set({ updatedAt: new Date() }).where(eq(trips.id, trip.id));
    expect(diffTrip(before, await record(trip.id))).toEqual([]);
  });
});

describe("recording a change", () => {
  beforeEach(reset);

  it("writes who did it, in the name they had at the time", async () => {
    const user = await makeUser("Amar Pant");
    const trip = await makeTrip();

    await updateTrip(trip.id, { bookedHours: 5 }, await actorFor(user.id));

    // Renaming the person later must not rewrite what the log says.
    await db.update(users).set({ name: "A. Pant" }).where(eq(users.id, user.id));

    const [event] = await listTripEvents(trip.id);
    expect(event.actorName).toBe("Amar Pant");
    expect(event.actorUserId).toBe(user.id);
    expect(event.changes).toEqual([{ field: "Hours booked", from: "2", to: "5" }]);
  });

  it("leaves no footprint when the save changed nothing", async () => {
    const user = await makeUser();
    const trip = await makeTrip();
    await updateTrip(trip.id, { bookedHours: 2 }, await actorFor(user.id));
    expect(await listTripEvents(trip.id)).toEqual([]);
  });

  it("records nothing when the change was refused", async () => {
    const user = await makeUser();
    const [driver] = await db
      .insert(drivers)
      .values({ name: "Marco Rinaldi", phone: "+1 917 555 0199" })
      .returning();
    const trip = await makeTrip();
    await db.insert(trips).values({
      reference: "T-10433", passengerName: "Other", pickupAddress: "a", dropoffAddress: "b",
      pickupAt: at(10), bookedHours: 2, vehicleClass: "SEDAN", driverId: driver.id,
    });

    await expect(
      updateTrip(trip.id, { driverId: driver.id }, await actorFor(user.id))
    ).rejects.toThrow(/already on/);
    expect(await listTripEvents(trip.id)).toEqual([]);
  });

  it("calls a cancellation a cancellation", async () => {
    const user = await makeUser();
    const trip = await makeTrip();
    await updateTrip(trip.id, { status: "CANCELLED" }, await actorFor(user.id));
    const [event] = await listTripEvents(trip.id);
    expect(event.kind).toBe("CANCELLED");
  });

  it("reads the same way twice when two events share a timestamp", async () => {
    // Ordering on createdAt alone left two events written in the same
    // millisecond with no defined order, so a history could read differently
    // on two loads. In an audit trail that is worse than it sounds: the whole
    // value of one is that it says the same thing every time.
    const trip = await makeTrip();
    const actor = await actorFor(undefined);
    const at = new Date("2026-09-22T12:00:00.000Z");

    for (const to of ["3", "4", "5"]) {
      await db.insert(tripEvents).values({
        tripId: trip.id, actorName: actor.name, kind: "UPDATED",
        changes: [{ field: "Hours booked", from: "2", to }], createdAt: at,
      });
    }

    const once = (await listTripEvents(trip.id)).map((e) => e.id);
    const twice = (await listTripEvents(trip.id)).map((e) => e.id);
    expect(once).toEqual(twice);
    expect(once).toHaveLength(3);
  });

  it("reads forwards, oldest first", async () => {
    const user = await makeUser();
    const trip = await makeTrip();
    const actor = await actorFor(user.id);
    await updateTrip(trip.id, { bookedHours: 3 }, actor);
    await updateTrip(trip.id, { bookedHours: 4 }, actor);
    const events = await listTripEvents(trip.id);
    expect(events.map((e) => e.changes[0].to)).toEqual(["3", "4"]);
  });

  it("attributes to the desk when no person pressed anything", async () => {
    const trip = await makeTrip();
    await recordTripEvent({ tripId: trip.id, actor: await actorFor(undefined), kind: "CREATED" });
    const [event] = await listTripEvents(trip.id);
    expect(event.actorName).toBe("Support Desk");
    expect(event.actorUserId).toBeNull();
  });

  it("keeps the trail if the person who made the change is removed", async () => {
    const user = await makeUser();
    const trip = await makeTrip();
    await updateTrip(trip.id, { bookedHours: 6 }, await actorFor(user.id));
    await db.delete(users).where(eq(users.id, user.id));

    const [event] = await listTripEvents(trip.id);
    expect(event.actorName).toBe("Amar Pant");
    expect(event.actorUserId).toBeNull();
  });
});

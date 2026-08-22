import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { db, pool } from "../../db/client";
import { affiliates, driverShifts, drivers, invoiceLines, invoices, trips, vehicles } from "../../db/schema";
import { searchTrips, updateTrip, findDriverClashes, MAX_TRIP_LIMIT, DEFAULT_TRIP_LIMIT } from "../trips";
import { updateDriver, listDrivers } from "../directory";
import { overlapsWindow } from "../availability";

const NOW = new Date("2026-09-22T00:00:00.000Z");
const at = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000);

async function resetOps() {
  await db.delete(invoiceLines);
  await db.delete(invoices);
  await db.delete(trips);
  await db.delete(driverShifts);
  await db.delete(drivers);
  await db.delete(affiliates);
  await db.delete(vehicles);
}

async function makeDriver(name = "Marco Rinaldi") {
  const [d] = await db.insert(drivers).values({ name, phone: "+1 917 555 0199" }).returning();
  return d;
}

async function makeTrip(over: Partial<typeof trips.$inferInsert> = {}) {
  const [t] = await db.insert(trips).values({
    reference: "T-10432",
    passengerName: "Ana Costa",
    bookerEmail: "ana@customer.example",
    pickupAddress: "230 Park Ave", dropoffAddress: "JFK Terminal 4",
    pickupAt: at(10), bookedHours: 2,
    vehicleClass: "SEDAN",
    ...over,
  }).returning();
  return t;
}

afterAll(async () => {
  await pool.end();
});

// --- No database needed ---------------------------------------------------

describe("overlapsWindow", () => {
  // The one definition of "these collide", shared by the availability search
  // and the double-booking refusal. If this drifts, two screens start
  // disagreeing about whether a driver is free.
  it("sees a genuine overlap", () => {
    expect(overlapsWindow(at(10), 2, at(11), at(13))).toBe(true);
  });

  it("does not count back-to-back work as a clash", () => {
    // Ends at 12, next starts at 12. That is a normal day, not a conflict.
    expect(overlapsWindow(at(10), 2, at(12), at(14))).toBe(false);
    expect(overlapsWindow(at(12), 2, at(10), at(12))).toBe(false);
  });

  it("sees a booking wholly inside the window", () => {
    expect(overlapsWindow(at(11), 1, at(10), at(14))).toBe(true);
  });

  it("sees a window wholly inside a booking", () => {
    expect(overlapsWindow(at(8), 8, at(11), at(12))).toBe(true);
  });

  it("leaves separate days alone", () => {
    expect(overlapsWindow(at(10), 2, at(34), at(36))).toBe(false);
  });
});

// --- Postgres needed below ------------------------------------------------

describe("findDriverClashes", () => {
  beforeEach(resetOps);

  it("finds the trip a driver is already on", async () => {
    const driver = await makeDriver();
    const booked = await makeTrip({ driverId: driver.id, pickupAt: at(10), bookedHours: 3 });

    const clashes = await findDriverClashes({ driverId: driver.id, pickupAt: at(11), hours: 2 });
    expect(clashes.map((c) => c.id)).toEqual([booked.id]);
  });

  it("ignores the trip being edited", async () => {
    const driver = await makeDriver();
    const trip = await makeTrip({ driverId: driver.id, pickupAt: at(10), bookedHours: 3 });

    const clashes = await findDriverClashes({
      driverId: driver.id, pickupAt: at(10), hours: 3, excludeTripId: trip.id,
    });
    expect(clashes).toEqual([]);
  });

  it("ignores a cancelled trip, which holds nobody's time", async () => {
    const driver = await makeDriver();
    await makeTrip({ driverId: driver.id, pickupAt: at(10), bookedHours: 3, status: "CANCELLED" });

    expect(await findDriverClashes({ driverId: driver.id, pickupAt: at(11), hours: 2 })).toEqual([]);
  });

  it("allows a tight turnaround, because refusing one would overrule the dispatcher", async () => {
    // The availability search keeps a 45-minute travel buffer so it suggests
    // sensibly. This is a refusal, not a suggestion, and a dispatcher who can
    // see the road is allowed to book back-to-back.
    const driver = await makeDriver();
    await makeTrip({ driverId: driver.id, pickupAt: at(10), bookedHours: 2 });

    expect(await findDriverClashes({ driverId: driver.id, pickupAt: at(12), hours: 2 })).toEqual([]);
  });
});

describe("updateTrip", () => {
  beforeEach(resetOps);

  it("refuses to double-book a driver, and names the clash", async () => {
    const driver = await makeDriver("Marco Rinaldi");
    await makeTrip({ reference: "T-10432", driverId: driver.id, pickupAt: at(10), bookedHours: 3 });
    const second = await makeTrip({ reference: "T-10500", pickupAt: at(11), bookedHours: 2 });

    await expect(updateTrip(second.id, { driverId: driver.id })).rejects.toThrow(
      /Marco Rinaldi is already on T-10432/
    );
  });

  it("refuses when moving a trip creates the clash, not only when assigning one", async () => {
    const driver = await makeDriver();
    await makeTrip({ reference: "T-10432", driverId: driver.id, pickupAt: at(10), bookedHours: 3 });
    // Assigned somewhere harmless, then dragged on top of the other one.
    const second = await makeTrip({
      reference: "T-10500", driverId: driver.id, pickupAt: at(20), bookedHours: 2,
    });

    await expect(updateTrip(second.id, { pickupAt: at(11) })).rejects.toThrow(/already on T-10432/);
  });

  it("lets the same trip be edited without clashing with itself", async () => {
    const driver = await makeDriver();
    const trip = await makeTrip({ driverId: driver.id, pickupAt: at(10), bookedHours: 2 });

    const updated = await updateTrip(trip.id, { notes: "Customer will call on arrival" });
    expect(updated.notes).toBe("Customer will call on arrival");
  });

  it("allows the assignment once the clashing trip is cancelled", async () => {
    const driver = await makeDriver();
    const first = await makeTrip({ reference: "T-10432", driverId: driver.id, pickupAt: at(10), bookedHours: 3 });
    const second = await makeTrip({ reference: "T-10500", pickupAt: at(11), bookedHours: 2 });

    await expect(updateTrip(second.id, { driverId: driver.id })).rejects.toThrow(/already on/);
    await updateTrip(first.id, { status: "CANCELLED" });
    const assigned = await updateTrip(second.id, { driverId: driver.id });
    expect(assigned.driver?.name).toBe("Marco Rinaldi");
  });

  it("does not guard a trip being cancelled, since it then holds nobody", async () => {
    const driver = await makeDriver();
    await makeTrip({ reference: "T-10432", driverId: driver.id, pickupAt: at(10), bookedHours: 3 });
    const second = await makeTrip({
      reference: "T-10500", driverId: driver.id, pickupAt: at(20), bookedHours: 2,
    });

    const cancelled = await updateTrip(second.id, { pickupAt: at(11), status: "CANCELLED" });
    expect(cancelled.status).toBe("CANCELLED");
  });

  it("refuses to put new work on a deactivated driver", async () => {
    const driver = await makeDriver("Retired Rita");
    await updateDriver(driver.id, { active: false });
    const trip = await makeTrip();

    await expect(updateTrip(trip.id, { driverId: driver.id })).rejects.toThrow(
      /Retired Rita is deactivated/
    );
  });

  it("says plainly when the driver, vehicle or affiliate does not exist", async () => {
    const trip = await makeTrip();
    await expect(updateTrip(trip.id, { driverId: "nobody" })).rejects.toThrow(/No driver with id nobody/);
    await expect(updateTrip(trip.id, { vehicleId: "no-car" })).rejects.toThrow(/No vehicle with id no-car/);
    await expect(updateTrip(trip.id, { affiliateId: "no-firm" })).rejects.toThrow(/No affiliate with id no-firm/);
  });

  it("says plainly when the trip does not exist", async () => {
    await expect(updateTrip("no-such-trip", { notes: "x" })).rejects.toThrow(/No trip with id no-such-trip/);
  });

  it("returns the full trip shape, driver and vehicle attached", async () => {
    const driver = await makeDriver();
    const [v] = await db.insert(vehicles).values({
      label: "Sedan 1", class: "SEDAN", makeModel: "Cadillac XTS", plate: "T1",
      passengerCapacity: 3, luggageCapacity: 3,
    }).returning();
    const trip = await makeTrip();

    const updated = await updateTrip(trip.id, { driverId: driver.id, vehicleId: v.id });
    expect(updated.driver?.phone).toBe("+1 917 555 0199");
    expect(updated.vehicle?.label).toBe("Sedan 1");
  });
});

describe("deactivating keeps the history readable", () => {
  beforeEach(resetOps);

  it("leaves past trips pointing at a deactivated driver", async () => {
    const driver = await makeDriver("Retired Rita");
    await makeTrip({ driverId: driver.id, pickupAt: at(-200), status: "COMPLETED" });

    await updateDriver(driver.id, { active: false });

    // The driver row is still there, still named on the trip. This is the
    // whole reason there is no DELETE for drivers.
    const { trips: found } = await searchTrips({ driverId: driver.id });
    expect(found).toHaveLength(1);
    expect(found[0].driver?.name).toBe("Retired Rita");

    // And they are still listed, so an admin can turn them back on.
    const listed = await listDrivers();
    expect(listed.find((d) => d.id === driver.id)?.active).toBe(false);
  });
});

describe("searchTrips", () => {
  beforeEach(async () => {
    await resetOps();
    await makeTrip({ reference: "T-10001", passengerName: "Ana Costa", bookerEmail: "ana@customer.example", pickupAt: at(-48), status: "COMPLETED" });
    await makeTrip({ reference: "T-10002", passengerName: "Bob Neale", bookerEmail: "bob@firm.example", pickupAt: at(-24), status: "CANCELLED" });
    await makeTrip({ reference: "T-10003", passengerName: "Ana Costa", bookerEmail: "ANA@customer.example", pickupAt: at(24) });
  });

  it("returns newest pickup first, with a total", async () => {
    const result = await searchTrips();
    expect(result.trips.map((t) => t.reference)).toEqual(["T-10003", "T-10002", "T-10001"]);
    expect(result.total).toBe(3);
  });

  it("includes cancelled trips, which is what a billing dispute needs", async () => {
    const result = await searchTrips();
    expect(result.trips.map((t) => t.status)).toContain("CANCELLED");
  });

  it("filters by a date range", async () => {
    const result = await searchTrips({ from: at(-30), to: at(0) });
    expect(result.trips.map((t) => t.reference)).toEqual(["T-10002"]);
    expect(result.total).toBe(1);
  });

  it("filters by status", async () => {
    const result = await searchTrips({ status: "COMPLETED" });
    expect(result.trips.map((t) => t.reference)).toEqual(["T-10001"]);
  });

  it("matches the reference, the passenger and the booker email, ignoring case", async () => {
    expect((await searchTrips({ q: "10002" })).trips.map((t) => t.reference)).toEqual(["T-10002"]);
    expect((await searchTrips({ q: "COSTA" })).trips.map((t) => t.reference)).toEqual(["T-10003", "T-10001"]);
    expect((await searchTrips({ q: "bob@firm" })).trips.map((t) => t.reference)).toEqual(["T-10002"]);
    expect((await searchTrips({ q: "ana@customer" })).trips.map((t) => t.reference)).toEqual(["T-10003", "T-10001"]);
  });

  it("finds nothing rather than everything for a search that matches nothing", async () => {
    const result = await searchTrips({ q: "nobody at all" });
    expect(result.trips).toEqual([]);
    expect(result.total).toBe(0);
  });

  it("reports the total independently of the page", async () => {
    const page = await searchTrips({ limit: 1, offset: 1 });
    expect(page.trips.map((t) => t.reference)).toEqual(["T-10002"]);
    // The count is of everything matching, not of what came back.
    expect(page.total).toBe(3);
  });

  it("caps the page size however large a limit is asked for", async () => {
    const result = await searchTrips({ limit: MAX_TRIP_LIMIT + 5_000 });
    expect(result.trips.length).toBeLessThanOrEqual(MAX_TRIP_LIMIT);
    expect(DEFAULT_TRIP_LIMIT).toBeLessThan(MAX_TRIP_LIMIT);
  });
});

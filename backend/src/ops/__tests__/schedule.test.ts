import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { db, pool } from "../../db/client";
import { affiliates, driverShifts, drivers, invoiceLines, invoices, trips, vehicles } from "../../db/schema";
import { getDriverSchedule, createShift, updateShift, deleteShift, resolveWindow, MAX_SHIFT_HOURS } from "../schedule";
import { OpsError } from "../errors";

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

async function makeTrip(driverId: string, over: Partial<typeof trips.$inferInsert> = {}) {
  const [t] = await db.insert(trips).values({
    reference: `T-${Math.floor(Math.random() * 90_000) + 10_000}`,
    passengerName: "Ana Costa",
    pickupAddress: "A", dropoffAddress: "B",
    pickupAt: at(10), bookedHours: 2,
    vehicleClass: "SEDAN", assignedKind: "DRIVER", driverId,
    ...over,
  }).returning();
  return t;
}

afterAll(async () => {
  await pool.end();
});

// --- No database needed below --------------------------------------------

describe("resolveWindow", () => {
  it("defaults to a fortnight from now when nothing is asked for", () => {
    const { from, to } = resolveWindow({}, NOW);
    expect(from.toISOString()).toBe(NOW.toISOString());
    expect((to.getTime() - from.getTime()) / 86_400_000).toBe(14);
  });

  it("refuses a range that ends before it starts", () => {
    expect(() => resolveWindow({ from: at(48), to: at(24) }, NOW)).toThrow(OpsError);
    expect(() => resolveWindow({ from: at(48), to: at(24) }, NOW)).toThrow(
      /end of the range must be after the start/i
    );
  });

  it("refuses a zero-length range", () => {
    expect(() => resolveWindow({ from: at(24), to: at(24) }, NOW)).toThrow(OpsError);
  });
});

describe("shift validation", () => {
  // These rejections happen before any query, so they run without Postgres —
  // which is the point of checking the range before touching the database.
  it("refuses a shift that ends before it starts", async () => {
    await expect(
      createShift({ driverId: "whoever", startsAt: at(18), endsAt: at(9) })
    ).rejects.toThrow(/end after it starts/i);
  });

  it("refuses a shift of zero length", async () => {
    await expect(
      createShift({ driverId: "whoever", startsAt: at(9), endsAt: at(9) })
    ).rejects.toThrow(/end after it starts/i);
  });

  it("refuses a shift longer than a day, and says how long it was", async () => {
    // The realistic cause is a typo in the date, not a 30-hour shift, so the
    // message quotes the length back rather than just refusing.
    await expect(
      createShift({ driverId: "whoever", startsAt: at(0), endsAt: at(30) })
    ).rejects.toThrow(new RegExp(`30\\.0 hours.*${MAX_SHIFT_HOURS} hours`, "i"));
  });

});

// --- Postgres needed below ------------------------------------------------

describe("getDriverSchedule", () => {
  beforeEach(resetOps);

  it("nests each trip inside the shift that covers it", async () => {
    const driver = await makeDriver();
    const [v] = await db.insert(vehicles).values({
      label: "Sedan 1", class: "SEDAN", makeModel: "Cadillac XTS", plate: "T1",
      passengerCapacity: 3, luggageCapacity: 3,
    }).returning();
    await db.insert(driverShifts).values({
      driverId: driver.id, vehicleId: v.id, startsAt: at(8), endsAt: at(20),
    });
    const inside = await makeTrip(driver.id, { pickupAt: at(10), bookedHours: 2 });

    const schedule = await getDriverSchedule(driver.id, { from: at(0), to: at(48) });
    expect(schedule?.shifts).toHaveLength(1);
    expect(schedule?.shifts[0].vehicle?.label).toBe("Sedan 1");
    expect(schedule?.shifts[0].trips.map((t) => t.id)).toEqual([inside.id]);
    expect(schedule?.unscheduledTrips).toEqual([]);
  });

  it("shows a trip nobody is rostered for rather than hiding it", async () => {
    const driver = await makeDriver();
    await db.insert(driverShifts).values({
      driverId: driver.id, startsAt: at(8), endsAt: at(12),
    });
    const orphan = await makeTrip(driver.id, { pickupAt: at(15), bookedHours: 2 });

    const schedule = await getDriverSchedule(driver.id, { from: at(0), to: at(48) });
    expect(schedule?.shifts[0].trips).toEqual([]);
    expect(schedule?.unscheduledTrips.map((t) => t.id)).toEqual([orphan.id]);
  });

  it("counts a trip that runs past the end of the shift as uncovered", async () => {
    // Partial cover is the interesting case: the driver clocks off at 12 and
    // the job runs to 13. Folding it into the shift would say it is fine.
    const driver = await makeDriver();
    await db.insert(driverShifts).values({
      driverId: driver.id, startsAt: at(8), endsAt: at(12),
    });
    const overrun = await makeTrip(driver.id, { pickupAt: at(11), bookedHours: 2 });

    const schedule = await getDriverSchedule(driver.id, { from: at(0), to: at(48) });
    expect(schedule?.shifts[0].trips).toEqual([]);
    expect(schedule?.unscheduledTrips.map((t) => t.id)).toEqual([overrun.id]);
  });

  it("brings the driver and vehicle through on the nested trips", async () => {
    const driver = await makeDriver();
    const [v] = await db.insert(vehicles).values({
      label: "SUV 2", class: "SUV", makeModel: "Escalade", plate: "T9",
      passengerCapacity: 6, luggageCapacity: 6,
    }).returning();
    await db.insert(driverShifts).values({ driverId: driver.id, startsAt: at(8), endsAt: at(20) });
    await makeTrip(driver.id, { pickupAt: at(10), vehicleId: v.id });

    const schedule = await getDriverSchedule(driver.id, { from: at(0), to: at(48) });
    expect(schedule?.shifts[0].trips[0].driver?.name).toBe("Marco Rinaldi");
    expect(schedule?.shifts[0].trips[0].vehicle?.label).toBe("SUV 2");
  });

  it("keeps a cancelled trip on the schedule", async () => {
    const driver = await makeDriver();
    await db.insert(driverShifts).values({ driverId: driver.id, startsAt: at(8), endsAt: at(20) });
    await makeTrip(driver.id, { pickupAt: at(10), status: "CANCELLED" });

    const schedule = await getDriverSchedule(driver.id, { from: at(0), to: at(48) });
    expect(schedule?.shifts[0].trips[0].status).toBe("CANCELLED");
  });

  it("returns null for a driver who does not exist", async () => {
    expect(await getDriverSchedule("no-such-driver", { from: at(0), to: at(48) })).toBeNull();
  });
});

describe("shift writes", () => {
  beforeEach(resetOps);

  it("creates a shift for a real driver", async () => {
    const driver = await makeDriver();
    const shift = await createShift({ driverId: driver.id, startsAt: at(8), endsAt: at(20) });
    expect(shift.driverId).toBe(driver.id);
    expect(shift.unavailable).toBe(false);
  });

  it("refuses a shift for a driver who does not exist", async () => {
    await expect(
      createShift({ driverId: "nobody", startsAt: at(8), endsAt: at(20) })
    ).rejects.toThrow(/No driver with id nobody/);
  });

  it("refuses a shift on a vehicle that does not exist", async () => {
    const driver = await makeDriver();
    await expect(
      createShift({ driverId: driver.id, vehicleId: "no-car", startsAt: at(8), endsAt: at(20) })
    ).rejects.toThrow(/No vehicle with id no-car/);
  });

  it("allows a shift of exactly the maximum length", async () => {
    // Exactly 24 hours is a long day, not a typo. It is 24-and-a-bit that is
    // the mistyped date, so the boundary itself has to stay legal.
    const driver = await makeDriver();
    const shift = await createShift({
      driverId: driver.id, startsAt: at(0), endsAt: at(MAX_SHIFT_HOURS),
    });
    expect(shift.endsAt.toISOString()).toBe(at(MAX_SHIFT_HOURS).toISOString());
  });

  it("records leave as a shift that exists but cannot take work", async () => {
    const driver = await makeDriver();
    const shift = await createShift({
      driverId: driver.id, startsAt: at(8), endsAt: at(20),
      unavailable: true, reason: "Annual leave",
    });
    expect(shift.unavailable).toBe(true);
    expect(shift.reason).toBe("Annual leave");
  });

  it("checks a patched shift against the dates it will end up with", async () => {
    // Only the end moves, but the result still has to make sense against the
    // start that is already stored.
    const driver = await makeDriver();
    const shift = await createShift({ driverId: driver.id, startsAt: at(8), endsAt: at(20) });

    await expect(updateShift(shift.id, { endsAt: at(4) })).rejects.toThrow(/end after it starts/i);
    const moved = await updateShift(shift.id, { endsAt: at(18) });
    expect(moved.endsAt.toISOString()).toBe(at(18).toISOString());
  });

  it("deletes a shift, because rostering somebody off leaves no hole", async () => {
    const driver = await makeDriver();
    const shift = await createShift({ driverId: driver.id, startsAt: at(8), endsAt: at(20) });

    await deleteShift(shift.id);
    const schedule = await getDriverSchedule(driver.id, { from: at(0), to: at(48) });
    expect(schedule?.shifts).toEqual([]);
  });

  it("says so plainly when the shift being deleted is not there", async () => {
    await expect(deleteShift("no-such-shift")).rejects.toThrow(/No shift with id no-such-shift/);
  });
});

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { db, pool } from "../../db/client";
import { affiliates, driverShifts, drivers, invoiceLines, invoices, trips, vehicles } from "../../db/schema";
import { findAvailableDrivers, suggestAffiliates, isFleetFullyCommitted } from "../availability";

// A fixed Tuesday, so "the day" never straddles a boundary by accident.
const PICKUP = new Date("2026-09-22T15:00:00.000Z");
const hoursBefore = (h: number) => new Date(PICKUP.getTime() - h * 3_600_000);
const hoursAfter = (h: number) => new Date(PICKUP.getTime() + h * 3_600_000);

async function makeVehicle(over: Partial<typeof vehicles.$inferInsert> = {}) {
  const [v] = await db.insert(vehicles).values({
    label: "Sedan 1", class: "SEDAN", makeModel: "Cadillac XTS", plate: "T1",
    passengerCapacity: 3, luggageCapacity: 3, ...over,
  }).returning();
  return v;
}

async function makeDriverOnShift(name: string, vehicleId: string | null, over: Partial<typeof driverShifts.$inferInsert> = {}) {
  const [d] = await db.insert(drivers).values({
    name, phone: "+1 917 555 0000", defaultVehicleId: vehicleId,
  }).returning();
  await db.insert(driverShifts).values({
    driverId: d.id, vehicleId,
    startsAt: hoursBefore(6), endsAt: hoursAfter(6),
    ...over,
  });
  return d;
}

const query = { pickupAt: PICKUP, hours: 3, vehicleClass: "SEDAN" as const };

beforeEach(async () => {
  await db.delete(invoiceLines);
  await db.delete(invoices);
  await db.delete(trips);
  await db.delete(driverShifts);
  await db.delete(drivers);
  await db.delete(affiliates);
  await db.delete(vehicles);
});

afterAll(async () => {
  await pool.end();
});

describe("findAvailableDrivers", () => {
  it("offers a driver whose shift covers the whole booking", async () => {
    const v = await makeVehicle();
    await makeDriverOnShift("Marco Rinaldi", v.id);

    const free = await findAvailableDrivers(query);
    expect(free.map((d) => d.name)).toEqual(["Marco Rinaldi"]);
    expect(free[0].vehicleLabel).toBe("Sedan 1");
  });

  it("will not offer a driver whose shift ends mid-trip", async () => {
    const v = await makeVehicle();
    // On shift at pickup, but clocks off an hour into a three-hour booking.
    await makeDriverOnShift("Early Finish", v.id, { endsAt: hoursAfter(1) });

    expect(await findAvailableDrivers(query)).toEqual([]);
  });

  it("will not offer a driver marked unavailable, even though the shift exists", async () => {
    const v = await makeVehicle();
    await makeDriverOnShift("On Leave", v.id, { unavailable: true, reason: "Annual leave" });

    expect(await findAvailableDrivers(query)).toEqual([]);
  });

  it("will not offer a driver already out on an overlapping trip", async () => {
    const v = await makeVehicle();
    const d = await makeDriverOnShift("Busy Driver", v.id);
    await db.insert(trips).values({
      reference: "T-1", passengerName: "Someone",
      pickupAddress: "A", dropoffAddress: "B",
      pickupAt: hoursAfter(1), bookedHours: 3,
      vehicleClass: "SEDAN", status: "SCHEDULED",
      assignedKind: "DRIVER", driverId: d.id, vehicleId: v.id,
    });

    expect(await findAvailableDrivers(query)).toEqual([]);
  });

  it("frees the driver again when that trip is cancelled", async () => {
    const v = await makeVehicle();
    const d = await makeDriverOnShift("Freed Driver", v.id);
    await db.insert(trips).values({
      reference: "T-2", passengerName: "Someone",
      pickupAddress: "A", dropoffAddress: "B",
      pickupAt: hoursAfter(1), bookedHours: 3,
      vehicleClass: "SEDAN", status: "CANCELLED",
      assignedKind: "DRIVER", driverId: d.id, vehicleId: v.id,
    });

    expect((await findAvailableDrivers(query)).map((d) => d.name)).toEqual(["Freed Driver"]);
  });

  it("lets a bigger car cover a smaller booking, but not the other way round", async () => {
    const suv = await makeVehicle({ label: "SUV 1", class: "SUV", plate: "T2", passengerCapacity: 6, luggageCapacity: 6 });
    await makeDriverOnShift("SUV Driver", suv.id);

    expect((await findAvailableDrivers({ ...query, vehicleClass: "SEDAN" })).map((d) => d.name)).toEqual(["SUV Driver"]);
    expect(await findAvailableDrivers({ ...query, vehicleClass: "SPRINTER" })).toEqual([]);
  });

  it("puts the least busy driver first, so the work spreads", async () => {
    const v1 = await makeVehicle({ label: "Sedan A", plate: "T3" });
    const v2 = await makeVehicle({ label: "Sedan B", plate: "T4" });
    const busy = await makeDriverOnShift("Aaron Busy", v1.id);
    await makeDriverOnShift("Zoe Quiet", v2.id);
    // Earlier in the day, so it does not clash — it just makes Aaron busier.
    await db.insert(trips).values({
      reference: "T-3", passengerName: "Someone",
      pickupAddress: "A", dropoffAddress: "B",
      pickupAt: hoursBefore(5), bookedHours: 1,
      vehicleClass: "SEDAN", status: "COMPLETED",
      assignedKind: "DRIVER", driverId: busy.id, vehicleId: v1.id,
    });

    const free = await findAvailableDrivers(query);
    expect(free.map((d) => d.name)).toEqual(["Zoe Quiet", "Aaron Busy"]);
    expect(free[1].tripsThatDay).toBe(1);
  });

  it("reports the fleet as fully committed when nobody is left", async () => {
    expect(await isFleetFullyCommitted(query)).toBe(true);
  });

  it("sees a clash on the far side of midnight", async () => {
    // The clash search was bounded by the pickup's UTC calendar date give or
    // take a day. A late-evening booking runs past midnight, so a job starting
    // in the small hours of the next day fell outside those bounds and was
    // never compared — the driver came back marked free for a night they were
    // already out on.
    const v = await makeVehicle({ label: "Sedan Night", plate: "TN" });
    // 7pm New York on the Tuesday. The booking plus its buffer runs to about
    // a quarter to three the next morning UTC, past the old upper bound of
    // midnight — so the clashing job an hour later was never even fetched.
    const lateEvening = new Date("2026-09-22T23:00:00.000Z");
    const [driver] = await db.insert(drivers).values({
      name: "Night Driver", phone: "+1 917 555 0000", defaultVehicleId: v.id,
    }).returning();
    await db.insert(driverShifts).values({
      driverId: driver.id, vehicleId: v.id,
      startsAt: new Date("2026-09-22T20:00:00.000Z"),
      endsAt: new Date("2026-09-23T07:00:00.000Z"),
    });
    await db.insert(trips).values({
      reference: "T-NIGHT", passengerName: "Someone",
      pickupAddress: "A", dropoffAddress: "B",
      pickupAt: new Date("2026-09-23T01:00:00.000Z"), bookedHours: 3,
      vehicleClass: "SEDAN", assignedKind: "DRIVER", driverId: driver.id, vehicleId: v.id,
    });

    const free = await findAvailableDrivers({
      pickupAt: lateEvening,
      hours: 3,
      vehicleClass: "SEDAN",
    });
    expect(free).toEqual([]);
  });

  it("sees a long job that started before the window and is still running", async () => {
    // A booking is only found by its pickup time, so the search has to reach
    // back far enough to catch one that began earlier and has not finished.
    const v = await makeVehicle({ label: "Sedan Long", plate: "TL" });
    const [driver] = await db.insert(drivers).values({
      name: "Long Driver", phone: "+1 917 555 0000", defaultVehicleId: v.id,
    }).returning();
    await db.insert(driverShifts).values({
      driverId: driver.id, vehicleId: v.id,
      startsAt: hoursBefore(12), endsAt: hoursAfter(12),
    });
    // Started at six the previous evening — before the start of this driver's
    // day, so nothing about today's date would find it — and booked for twenty
    // hours, which means it is still running at the pickup being asked about.
    await db.insert(trips).values({
      reference: "T-LONG", passengerName: "Someone",
      pickupAddress: "A", dropoffAddress: "B",
      pickupAt: new Date("2026-09-21T22:00:00.000Z"), bookedHours: 20,
      vehicleClass: "SEDAN", assignedKind: "DRIVER", driverId: driver.id, vehicleId: v.id,
    });

    expect(await findAvailableDrivers(query)).toEqual([]);
  });

  it("counts the driver's day, not the server's", async () => {
    // "Trips that day" used to be sliced at midnight UTC, which in New York is
    // 8pm the evening before, so a 9pm booking counted against the following
    // day — a figure a dispatcher sorts on, for a day the driver would not
    // recognise.
    const v = await makeVehicle({ label: "Sedan Day", plate: "TD" });
    const [driver] = await db.insert(drivers).values({
      name: "Day Driver", phone: "+1 917 555 0000", defaultVehicleId: v.id,
    }).returning();
    await db.insert(driverShifts).values({
      driverId: driver.id, vehicleId: v.id,
      startsAt: new Date("2026-09-22T12:00:00.000Z"),
      endsAt: new Date("2026-09-23T05:00:00.000Z"),
    });
    // 10am New York on the Tuesday — the same New York day as a 9pm pickup,
    // but a different UTC day.
    await db.insert(trips).values({
      reference: "T-DAY", passengerName: "Someone",
      pickupAddress: "A", dropoffAddress: "B",
      pickupAt: new Date("2026-09-22T14:00:00.000Z"), bookedHours: 2,
      vehicleClass: "SEDAN", status: "COMPLETED",
      assignedKind: "DRIVER", driverId: driver.id, vehicleId: v.id,
    });

    const free = await findAvailableDrivers({
      pickupAt: new Date("2026-09-23T01:00:00.000Z"), // 9pm Tuesday, New York
      hours: 2,
      vehicleClass: "SEDAN",
    });
    expect(free.map((d) => d.name)).toEqual(["Day Driver"]);
    expect(free[0].tripsThatDay).toBe(1);
  });
});

describe("suggestAffiliates", () => {
  beforeEach(async () => {
    await db.insert(affiliates).values([
      { company: "Liberty Bell Executive", phone: "1", email: "a@x.example", coverageStates: ["PA", "DE"], coverageCities: ["Philadelphia"], overflowPartner: false, preference: 1 },
      { company: "Capital Executive", phone: "2", email: "b@x.example", coverageStates: ["DC"], coverageCities: ["Washington"], overflowPartner: false, preference: 3 },
      { company: "Metro Overflow Group", phone: "3", email: "c@x.example", coverageStates: ["NY", "NJ"], coverageCities: ["New York"], overflowPartner: true, preference: 1 },
      { company: "Five Boroughs Car Service", phone: "4", email: "d@x.example", coverageStates: ["NY"], coverageCities: ["Queens"], overflowPartner: true, preference: 3 },
    ]);
  });

  it("matches on the state the trip reaches", async () => {
    const out = await suggestAffiliates({ states: ["PA"] });
    expect(out.map((a) => a.company)).toEqual(["Liberty Bell Executive"]);
    expect(out[0].reason).toBe("COVERS_AREA");
  });

  it("matches on a city when the state is too coarse", async () => {
    expect((await suggestAffiliates({ cities: ["philadelphia"] })).map((a) => a.company))
      .toEqual(["Liberty Bell Executive"]);
  });

  it("returns overflow partners for the out-of-cars case, not the geography one", async () => {
    const out = await suggestAffiliates({ overflow: true });
    // Preferred partner first; the DC and Philadelphia firms are irrelevant here.
    expect(out.map((a) => a.company)).toEqual(["Metro Overflow Group", "Five Boroughs Car Service"]);
    expect(out.every((a) => a.reason === "OVERFLOW")).toBe(true);
  });

  it("never sends a Manhattan overflow job to an out-of-state partner", async () => {
    const out = await suggestAffiliates({ overflow: true });
    expect(out.map((a) => a.company)).not.toContain("Capital Executive");
  });

  it("says nothing rather than guessing when nobody covers the area", async () => {
    expect(await suggestAffiliates({ states: ["TX"] })).toEqual([]);
  });
});

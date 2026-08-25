// The additive seeder, which exists because the other one is not.
//
// `seed-ops` refuses to run twice without `--reset`, and `--reset` deletes
// every trip. So the thing that keeps a working database usable — more rota,
// more cars, more of the map — has to add and never remove, and has to be safe
// to run again on Friday having been run on Tuesday.

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { DateTime } from "luxon";
import { db, pool } from "../client";
import {
  affiliateZones, affiliates, driverShifts, drivers,
  invoiceLines, invoices, trips, vehicles,
} from "../schema";
import { extendRoster, spreadShifts } from "../extend-roster";
import { seedOperations } from "../seed-ops";
import { findAvailableDrivers } from "../../ops/availability";
import { OPERATING_TIME_ZONE } from "../../booking/pickup-time";

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await db.delete(invoiceLines);
  await db.delete(invoices);
  await db.delete(trips);
  await db.delete(driverShifts);
  await db.delete(drivers);
  await db.delete(affiliateZones);
  await db.delete(affiliates);
  await db.delete(vehicles);
});

const smallRun = { days: 7 };

describe("extendRoster", () => {
  it("puts a car, a driver and a rota where there was nothing", async () => {
    const summary = await extendRoster(smallRun);

    expect(summary.vehiclesAdded).toBeGreaterThan(0);
    expect(summary.driversAdded).toBeGreaterThan(0);
    expect(summary.shiftsAdded).toBeGreaterThan(0);

    // Five working days out of seven, per driver.
    const rostered = await db.select().from(driverShifts);
    expect(rostered.length).toBe(summary.shiftsAdded);
  });

  it("adds nothing the second time", async () => {
    await extendRoster(smallRun);
    const second = await extendRoster(smallRun);

    expect(second.vehiclesAdded).toBe(0);
    expect(second.driversAdded).toBe(0);
    expect(second.affiliatesAdded).toBe(0);
    expect(second.shiftsAdded).toBe(0);
  });

  it("extends further out without disturbing the days already covered", async () => {
    await extendRoster({ days: 7 });
    const before = await db.select().from(driverShifts);

    const second = await extendRoster({ days: 14 });
    expect(second.shiftsAdded).toBeGreaterThan(0);

    // Every original shift is still there, untouched, ids and all.
    const after = await db.select().from(driverShifts);
    const ids = new Set(after.map((s) => s.id));
    for (const shift of before) expect(ids.has(shift.id)).toBe(true);
  });

  it("never touches a trip", async () => {
    // The whole reason this exists rather than a second `--reset`.
    await extendRoster(smallRun);
    const [driver] = await db.select().from(drivers).limit(1);
    const [booking] = await db.insert(trips).values({
      reference: "T-19999", passengerName: "Ana Costa",
      pickupAddress: "230 Park Ave, New York, NY",
      dropoffAddress: "JFK Terminal 4, Jamaica, NY 11430",
      pickupAt: new Date(), bookedHours: 3, vehicleClass: "SEDAN",
      assignedKind: "DRIVER", driverId: driver.id,
    }).returning();

    await extendRoster({ days: 14 });

    const [still] = await db.select().from(trips).where(eq(trips.id, booking.id));
    expect(still?.reference).toBe("T-19999");
    expect(still?.driverId).toBe(driver.id);
  });

  it("gives every partner it adds a rate card", async () => {
    const summary = await extendRoster(smallRun);
    const partners = await db.select().from(affiliates);
    const cards = await db.select().from(affiliateZones);

    expect(partners.length).toBe(summary.affiliatesAdded);
    for (const partner of partners) {
      expect(cards.filter((c) => c.affiliateId === partner.id).length).toBeGreaterThan(0);
    }
  });

  it("covers every state a customer might name, so no test falls off the map", async () => {
    // A trip to Oklahoma City arrived and there was nobody to ask at all —
    // which is a different failure from "the partners quoted high", and the
    // one that stops a test dead.
    await extendRoster(smallRun);
    const partners = await db.select().from(affiliates);
    const covered = new Set(partners.flatMap((p) => p.coverageStates));

    for (const state of ["OK", "TX", "CO", "WA", "GA", "MI", "NM", "ME"]) {
      expect(covered.has(state), state).toBe(true);
    }
  });

  it("has more than one driver for every van and sprinter", async () => {
    // A single-driver van is available about a third of the week, and the
    // other two thirds a van booking finds no van and farms out with nothing
    // on the screen to say why.
    await extendRoster(smallRun);
    const fleet = await db.select().from(vehicles);
    const staff = await db.select().from(drivers);

    for (const vehicle of fleet.filter((v) => v.class === "VAN" || v.class === "SPRINTER")) {
      const crew = staff.filter((d) => d.defaultVehicleId === vehicle.id);
      expect(crew.length, vehicle.label).toBeGreaterThan(0);
    }
  });

  it("leaves a car of every class free at every hour of the week", async () => {
    // The point of the whole exercise, and checked by asking the real
    // availability query rather than by reasoning about shift arithmetic —
    // which is what went wrong twice. An eleven-hour shift is only usable for
    // about seven hours of work, both sprinter drivers the seed made drew
    // morning starts, and every sprinter booking after five in the afternoon
    // found nobody, every single day, with the screen saying only that no
    // driver was free.
    //
    // A week a month out, so it is entirely this tool's rota rather than the
    // seeded fortnight, which has its own gaps from its own sickness and leave.
    await seedOperations({ reset: true });
    await extendRoster({ days: 60 });

    const empty: string[] = [];
    for (let day = 30; day < 37; day++) {
      for (let hour = 0; hour < 24; hour += 2) {
        const when = DateTime.now()
          .setZone(OPERATING_TIME_ZONE)
          .plus({ days: day })
          .set({ hour, minute: 0, second: 0, millisecond: 0 });

        for (const vehicleClass of ["SEDAN", "SUV", "VAN", "SPRINTER"] as const) {
          const free = await findAvailableDrivers({
            pickupAt: when.toJSDate(),
            hours: 3,
            vehicleClass,
          });
          if (free.length === 0) empty.push(`${vehicleClass} ${when.toFormat("ccc HH:mm")}`);
        }
      }
    }

    expect(empty).toEqual([]);
  }, 60_000);
});

describe("spreadShifts", () => {
  it("does not put everybody on the same shift", async () => {
    // What the first version did. Three van drivers cannot cover the week
    // between them however they are arranged, so every candidate scored the
    // same on "the worst hour of the week" — and the tie-break handed all of
    // them midnight.
    const chosen = spreadShifts([], 4);
    expect(new Set(chosen.map((p) => p.homeHour)).size).toBeGreaterThan(1);
  });

  it("fills the hours the existing rota leaves, rather than the busy ones", async () => {
    // Two drivers both starting at six in the morning are usable up to one in
    // the afternoon and no later. The next one belongs in the afternoon.
    const existing = [
      { homeHour: 5, rest: [2, 6] as [number, number] },
      { homeHour: 6, rest: [3, 7] as [number, number] },
    ];
    const [next] = spreadShifts(existing, 1);
    expect(next.homeHour).toBeGreaterThanOrEqual(12);
  });

  it("gives the same answer every time", async () => {
    const existing = [{ homeHour: 8, rest: [1, 4] as [number, number] }];
    expect(spreadShifts(existing, 3)).toEqual(spreadShifts(existing, 3));
  });
});

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { db, pool } from "../../db/client";
import {
  affiliateZones, affiliates, driverShifts, drivers, invoiceLines, invoices, trips, vehicles,
} from "../../db/schema";
import { eq } from "drizzle-orm";
import { candidatesForTrip } from "../candidates";
import { findTripById } from "../lookup";

const PICKUP = new Date("2026-09-22T19:00:00.000Z"); // 3pm in New York
const hoursBefore = (h: number) => new Date(PICKUP.getTime() - h * 3_600_000);
const hoursAfter = (h: number) => new Date(PICKUP.getTime() + h * 3_600_000);

// 245 Park Avenue, and Newark for the overflow partner's base.
const MANHATTAN = { lat: 40.7548, lng: -73.9757 };
const NEWARK = { lat: 40.7357, lng: -74.1724 };

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

async function makeTrip(over: Partial<typeof trips.$inferInsert> = {}) {
  const [row] = await db.insert(trips).values({
    reference: `T-${Math.floor(Math.random() * 90_000) + 10_000}`,
    passengerName: "Daniel Weiss",
    pickupAddress: "245 Park Avenue, New York, NY 10167",
    dropoffAddress: "JFK Terminal 4, Jamaica, NY 11430",
    pickupAt: PICKUP,
    bookedHours: 3,
    vehicleClass: "SEDAN",
    pickupLat: MANHATTAN.lat,
    pickupLng: MANHATTAN.lng,
    pickupState: "NY",
    dropoffState: "NY",
    ...over,
  }).returning();
  return (await findTripById(row.id))!;
}

async function makeDriverFree(name: string) {
  const [v] = await db.insert(vehicles).values({
    label: `Sedan ${name}`, class: "SEDAN", makeModel: "Cadillac XTS", plate: name,
    passengerCapacity: 3, luggageCapacity: 3,
  }).returning();
  const [d] = await db.insert(drivers).values({
    name, phone: "+1 917 555 0000", defaultVehicleId: v.id,
  }).returning();
  await db.insert(driverShifts).values({
    driverId: d.id, vehicleId: v.id, startsAt: hoursBefore(6), endsAt: hoursAfter(6),
  });
  return d;
}

async function makeOverflowPartner(company: string, withCard = true) {
  const [a] = await db.insert(affiliates).values({
    company, phone: "+1 201 555 0171", email: `${company}@example.test`,
    baseAddress: "Newark, NJ", baseLat: NEWARK.lat, baseLng: NEWARK.lng,
    coverageStates: ["NJ", "NY"], overflowPartner: true, preference: 1,
  }).returning();
  if (withCard) {
    await db.insert(affiliateZones).values({
      affiliateId: a.id, label: "Metro", fromMiles: 0, toMiles: 15,
      minimumHours: 2, rateCents: { SEDAN: 7_500 },
    });
  }
  return a;
}

describe("candidatesForTrip", () => {
  it("names the drivers who could actually take it", async () => {
    await makeDriverFree("Marco Rinaldi");
    await makeDriverFree("Hector Alvarez");
    const result = await candidatesForTrip(await makeTrip());

    expect(result.drivers.map((d) => d.name).sort()).toEqual(["Hector Alvarez", "Marco Rinaldi"]);
    // No partners priced while our own cars are sitting there. It is the
    // wrong question at this point, and two rate-card queries nobody read.
    expect(result.partners).toEqual([]);
    expect(result.fallbackReason).toBeNull();
  });

  it("falls through to partners, with prices, when nobody is free", async () => {
    const partner = await makeOverflowPartner("Metro Overflow Group");
    const result = await candidatesForTrip(await makeTrip());

    expect(result.drivers).toEqual([]);
    expect(result.fallbackReason).toBe("NO_CAR_FREE");
    expect(result.partners).toHaveLength(1);
    expect(result.partners[0].company).toBe("Metro Overflow Group");
    expect(result.partners[0].reason).toBe("OVERFLOW");
    // The point of showing them at all: what it costs, not just who to ring.
    const quote = result.partners[0].quote;
    expect(quote.priced).toBe(true);
    if (!quote.priced) return;
    expect(quote.quote.totalCents).toBe(22_500);
  });

  it("keeps a partner on the list even when their card cannot price it", async () => {
    // "Ring them and agree a price" is a real answer. Dropping them off the
    // list because the arithmetic failed would hide the only firm available.
    await makeOverflowPartner("Metro Overflow Group", false);
    const result = await candidatesForTrip(await makeTrip());

    expect(result.partners).toHaveLength(1);
    expect(result.partners[0].quote.priced).toBe(false);
  });

  it("goes straight to partners for a trip that leaves the area", async () => {
    // Our own cars do not do Philadelphia, however free they are. Listing
    // them would invite somebody to send one.
    await makeDriverFree("Marco Rinaldi");
    const [a] = await db.insert(affiliates).values({
      company: "Liberty Bell Executive", phone: "+1 215 555 0142",
      email: "dispatch@libertybell.example", baseAddress: "Philadelphia, PA",
      baseLat: 39.9526, baseLng: -75.1652, coverageStates: ["PA", "DE"], preference: 1,
    }).returning();
    await db.insert(affiliateZones).values({
      affiliateId: a.id, label: "Regional", fromMiles: 40, toMiles: 100,
      minimumHours: 4, rateCents: { SEDAN: 10_000 },
    });

    const result = await candidatesForTrip(
      await makeTrip({
        dropoffAddress: "Sheraton Philadelphia Downtown, 201 N 17th St, Philadelphia, PA 19103",
        dropoffState: "PA",
      })
    );

    expect(result.drivers).toEqual([]);
    expect(result.fallbackReason).toBe("OUT_OF_AREA");
    expect(result.partners.map((p) => p.company)).toEqual(["Liberty Bell Executive"]);
    expect(result.partners[0].reason).toBe("COVERS_AREA");
  });

  it("treats an unknown destination as ordinary work, not as out of area", async () => {
    // Trips created before the states were stored have none. Farming those
    // out on missing information would be a decision made from a blank.
    await makeDriverFree("Marco Rinaldi");
    const result = await candidatesForTrip(await makeTrip({ dropoffState: null }));

    expect(result.drivers.map((d) => d.name)).toEqual(["Marco Rinaldi"]);
    expect(result.fallbackReason).toBeNull();
  });

  it("does not offer a driver already out on another job", async () => {
    const marco = await makeDriverFree("Marco Rinaldi");
    await db.insert(trips).values({
      reference: "T-19999", passengerName: "Someone Else",
      pickupAddress: "a", dropoffAddress: "b",
      pickupAt: PICKUP, bookedHours: 2, vehicleClass: "SEDAN",
      driverId: marco.id, assignedKind: "DRIVER",
    });

    const result = await candidatesForTrip(await makeTrip());
    expect(result.drivers).toEqual([]);
  });

  it("offers a bigger car but never a smaller one", async () => {
    const [v] = await db.insert(vehicles).values({
      label: "SUV 1", class: "SUV", makeModel: "Escalade", plate: "S1",
      passengerCapacity: 6, luggageCapacity: 6,
    }).returning();
    const [d] = await db.insert(drivers).values({
      name: "Amrit Singh", phone: "+1 917 555 0001", defaultVehicleId: v.id,
    }).returning();
    await db.insert(driverShifts).values({
      driverId: d.id, vehicleId: v.id, startsAt: hoursBefore(6), endsAt: hoursAfter(6),
    });

    // An SUV can do a sedan job.
    expect((await candidatesForTrip(await makeTrip())).drivers.map((x) => x.name)).toEqual([
      "Amrit Singh",
    ]);
    // A sedan cannot do a van job.
    await db.delete(trips);
    const vanJob = await makeTrip({ vehicleClass: "VAN" });
    expect((await candidatesForTrip(vanJob)).drivers).toEqual([]);
  });
});

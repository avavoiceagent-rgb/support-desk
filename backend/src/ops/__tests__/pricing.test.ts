import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { db, pool } from "../../db/client";
import { affiliateZones, affiliates, trips } from "../../db/schema";
import { eq } from "drizzle-orm";
import { coverageGap, quoteTripForAffiliate } from "../pricing";
import { geocodedForAddress } from "../reservations";
import type { TripRecord } from "../lookup";

afterAll(async () => {
  await pool.end();
});

// Newark, roughly. Distances below are measured from here.
const BASE = { lat: 40.7357, lng: -74.1724 };
// 245 Park Avenue: about 9 miles from Newark in a straight line.
const MANHATTAN = { lat: 40.7548, lng: -73.9757 };
// Buffalo: still New York, so the partner covers it — but about 300 miles
// from Newark, well past any band set up here. Deliberately in-state, so the
// test measures the band overflow and not the coverage check.
const BUFFALO = { lat: 42.8864, lng: -78.8784 };

function tripLike(over: Partial<TripRecord> = {}): TripRecord {
  return {
    id: "t1",
    reference: "T-10001",
    ticketId: null,
    passengerName: "Ana Costa",
    passengerPhone: null,
    bookerName: null,
    bookerEmail: null,
    pickupAddress: "245 Park Avenue, New York, NY 10167",
    dropoffAddress: "JFK Terminal 4, Jamaica, NY 11430",
    stops: [],
    pickupAt: new Date("2026-09-01T13:00:00Z"),
    bookedHours: 3,
    actualHours: null,
    vehicleClass: "SEDAN",
    passengerCount: 2,
    luggageCount: 2,
    flightNumber: null,
    pickupLat: MANHATTAN.lat,
    pickupLng: MANHATTAN.lng,
    pickupState: "NY",
    dropoffLat: null,
    dropoffLng: null,
    dropoffState: "NY",
    status: "SCHEDULED",
    assignedKind: "UNASSIGNED",
    driverId: null,
    vehicleId: null,
    affiliateId: null,
    farmOutReason: null,
    notes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    driver: null,
    vehicle: null,
    affiliate: null,
    ...over,
  } as TripRecord;
}

async function makePartner(over: Partial<typeof affiliates.$inferInsert> = {}) {
  const [row] = await db
    .insert(affiliates)
    .values({
      company: "Garden State Chauffeur",
      phone: "+1 201 555 0171",
      email: "ops@gardenstate.example",
      baseAddress: "Newark, NJ",
      baseLat: BASE.lat,
      baseLng: BASE.lng,
      coverageStates: ["NJ", "NY"],
      ...over,
    })
    .returning();
  return row;
}

beforeEach(async () => {
  await db.delete(affiliateZones);
  await db.delete(trips);
  await db.delete(affiliates);
});

describe("geocodedForAddress", () => {
  const found = { lat: 40.7, lng: -74, state: "NY" };

  it("keeps what was found when the address is still the one that was geocoded", () => {
    expect(geocodedForAddress("245 Park Ave, New York, NY", "245 Park Ave, New York, NY", found))
      .toEqual({ lat: 40.7, lng: -74, state: "NY" });
  });

  it("ignores case and stray whitespace, which are not a different place", () => {
    expect(geocodedForAddress("  245 PARK AVE, New York, NY ", "245 Park Ave, New York, NY", found))
      .toEqual({ lat: 40.7, lng: -74, state: "NY" });
  });

  it("drops it when a dispatcher corrected the address", () => {
    // This is the whole reason the check exists: the old coordinates would
    // price the job from a place nobody is going to, and look right doing it.
    expect(geocodedForAddress("30 Hudson Yards, New York, NY", "245 Park Ave, New York, NY", found))
      .toEqual({ lat: null, lng: null, state: null });
  });

  it("drops it when there was never a point", () => {
    expect(geocodedForAddress("245 Park Ave", "245 Park Ave", { state: "NY" }))
      .toEqual({ lat: null, lng: null, state: null });
    expect(geocodedForAddress("245 Park Ave", undefined, found))
      .toEqual({ lat: null, lng: null, state: null });
  });

  it("does not keep a state without the point it came from", () => {
    // A trip that knows which state it is in but not where cannot be measured
    // against anything, and the half-record invites someone to trust it.
    expect(geocodedForAddress("245 Park Ave", "245 Park Ave", { lat: 40.7, state: "NY" }).state)
      .toBeNull();
  });
});

describe("coverageGap", () => {
  const laPartner = {
    company: "Pacific Coast Livery",
    coverageStates: ["CA"],
    baseAddress: "Los Angeles, CA",
  };

  it("objects before doing arithmetic on the wrong partner", () => {
    // The 2,447-mile quote that started this: measuring an LA card against a
    // Manhattan pickup is a right answer to a question nobody asked.
    const gap = coverageGap(laPartner, { pickupState: "NY", dropoffState: "NY" });
    expect(gap).toContain("covers CA");
    expect(gap).toContain("pickup is in NY");
  });

  it("says nothing when they work where the car is needed", () => {
    expect(coverageGap(laPartner, { pickupState: "CA", dropoffState: "NV" })).toBeNull();
  });

  it("points at the job they should actually be sent", () => {
    // A partner who covers the far end is how an out-of-area trip normally
    // gets done — but the job to hand them is the one that starts there.
    const gap = coverageGap(laPartner, { pickupState: "NY", dropoffState: "CA" });
    expect(gap).toContain("They do cover CA, where this trip ends");
  });

  it("does not object on behalf of a partner nobody has filled in", () => {
    // An empty coverage list means nobody said, not that they cover nowhere.
    expect(
      coverageGap({ company: "New Partner", coverageStates: [], baseAddress: null }, {
        pickupState: "NY",
        dropoffState: "NY",
      })
    ).toBeNull();
  });

  it("says nothing when the trip does not know where it starts", () => {
    // Older trips have no state. Silence beats accusing a partner on no
    // evidence — the missing-coordinates message covers that case anyway.
    expect(coverageGap(laPartner, { pickupState: null, dropoffState: null })).toBeNull();
  });
});

describe("quoteTripForAffiliate", () => {
  it("prices the job from the partner's base to the pickup", async () => {
    const partner = await makePartner();
    await db.insert(affiliateZones).values({
      affiliateId: partner.id,
      label: "Metro",
      fromMiles: 0,
      toMiles: 15,
      minimumHours: 2,
      rateCents: { SEDAN: 7_500 },
    });

    const result = await quoteTripForAffiliate(tripLike(), partner.id);
    expect(result.priced).toBe(true);
    if (!result.priced) return;
    expect(result.miles).toBeGreaterThan(8);
    expect(result.miles).toBeLessThan(11);
    expect(result.quote.zone.label).toBe("Metro");
    expect(result.quote.billableHours).toBe(3);
    expect(result.quote.totalCents).toBe(22_500);
  });

  it("applies the band's minimum to a short job", async () => {
    const partner = await makePartner();
    await db.insert(affiliateZones).values({
      affiliateId: partner.id,
      label: "Metro",
      fromMiles: 0,
      toMiles: 15,
      minimumHours: 4,
      rateCents: { SEDAN: 7_500 },
    });

    const result = await quoteTripForAffiliate(tripLike({ bookedHours: 2 }), partner.id);
    expect(result.priced).toBe(true);
    if (!result.priced) return;
    // Two hours booked, four billed. Seeing this before the job is handed
    // over is the difference between a decision and a surprise on an invoice.
    expect(result.quote.requestedHours).toBe(2);
    expect(result.quote.billableHours).toBe(4);
    expect(result.quote.totalCents).toBe(30_000);
  });

  it("says which class is missing rather than answering nothing", async () => {
    const partner = await makePartner();
    await db.insert(affiliateZones).values({
      affiliateId: partner.id,
      label: "Metro",
      fromMiles: 0,
      toMiles: 15,
      minimumHours: 2,
      rateCents: { SEDAN: 7_500 },
    });

    const result = await quoteTripForAffiliate(tripLike({ vehicleClass: "SPRINTER" }), partner.id);
    expect(result.priced).toBe(false);
    if (result.priced) return;
    expect(result.reason).toContain("sprinter");
    expect(result.reason).toContain("Metro");
  });

  it("refuses a partner who does not work where the pickup is", async () => {
    const partner = await makePartner({
      company: "Pacific Coast Livery",
      baseAddress: "Los Angeles, CA",
      baseLat: 34.0522,
      baseLng: -118.2437,
      coverageStates: ["CA"],
    });
    await db.insert(affiliateZones).values({
      affiliateId: partner.id,
      label: "Long haul",
      fromMiles: 100,
      toMiles: null,
      minimumHours: 6,
      rateCents: { SEDAN: 20_000 },
    });

    // Even with an open-ended band that would happily price 2,447 miles.
    const result = await quoteTripForAffiliate(tripLike(), partner.id);
    expect(result.priced).toBe(false);
    if (result.priced) return;
    expect(result.reason).toContain("wrong partner");
  });

  it("says when the job falls outside every band", async () => {
    const partner = await makePartner();
    await db.insert(affiliateZones).values({
      affiliateId: partner.id,
      label: "Metro",
      fromMiles: 0,
      toMiles: 15,
      minimumHours: 2,
      rateCents: { SEDAN: 7_500 },
    });

    const result = await quoteTripForAffiliate(
      tripLike({ pickupLat: BUFFALO.lat, pickupLng: BUFFALO.lng }),
      partner.id
    );
    expect(result.priced).toBe(false);
    if (result.priced) return;
    expect(result.reason).toMatch(/outside every band/);
  });

  it("refuses to price a booking that has no coordinates", async () => {
    const partner = await makePartner();
    await db.insert(affiliateZones).values({
      affiliateId: partner.id,
      label: "Metro",
      fromMiles: 0,
      toMiles: 15,
      minimumHours: 2,
      rateCents: { SEDAN: 7_500 },
    });

    // Every trip seeded or created before migration 0015 is in this state,
    // and inventing a mileage for them is exactly what must not happen.
    const result = await quoteTripForAffiliate(
      tripLike({ pickupLat: null, pickupLng: null }),
      partner.id
    );
    expect(result.priced).toBe(false);
    if (result.priced) return;
    expect(result.reason).toMatch(/no pickup coordinates/);
  });

  it("says so when we never recorded where the partner is based", async () => {
    const partner = await makePartner({ baseLat: null, baseLng: null });
    const result = await quoteTripForAffiliate(tripLike(), partner.id);
    expect(result.priced).toBe(false);
    if (result.priced) return;
    expect(result.reason).toContain("where Garden State Chauffeur is based");
  });

  it("says so when the partner has no card at all", async () => {
    const partner = await makePartner();
    const result = await quoteTripForAffiliate(tripLike(), partner.id);
    expect(result.priced).toBe(false);
    if (result.priced) return;
    expect(result.reason).toContain("no rate card yet");
  });
});

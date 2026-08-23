import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { db, pool } from "../../db/client";
import { affiliateZones, affiliates, trips } from "../../db/schema";
import { eq } from "drizzle-orm";
import { quoteTripForAffiliate } from "../pricing";
import { coordsForAddress } from "../reservations";
import type { TripRecord } from "../lookup";

afterAll(async () => {
  await pool.end();
});

// Newark, roughly. Distances below are measured from here.
const BASE = { lat: 40.7357, lng: -74.1724 };
// 245 Park Avenue: about 9 miles from Newark in a straight line.
const MANHATTAN = { lat: 40.7548, lng: -73.9757 };
// Philadelphia: about 80 miles out, well past any band we set up here.
const PHILADELPHIA = { lat: 39.9526, lng: -75.1652 };

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
    dropoffLat: null,
    dropoffLng: null,
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

describe("coordsForAddress", () => {
  it("keeps the point when the address is still the one that was geocoded", () => {
    expect(coordsForAddress("245 Park Ave, New York, NY", "245 Park Ave, New York, NY", 40.7, -74))
      .toEqual({ lat: 40.7, lng: -74 });
  });

  it("ignores case and stray whitespace, which are not a different place", () => {
    expect(coordsForAddress("  245 PARK AVE, New York, NY ", "245 Park Ave, New York, NY", 40.7, -74))
      .toEqual({ lat: 40.7, lng: -74 });
  });

  it("drops the point when a dispatcher corrected the address", () => {
    // This is the whole reason the check exists: the old coordinates would
    // price the job from a place nobody is going to, and look right doing it.
    expect(coordsForAddress("30 Hudson Yards, New York, NY", "245 Park Ave, New York, NY", 40.7, -74))
      .toEqual({ lat: null, lng: null });
  });

  it("drops the point when there was never one", () => {
    expect(coordsForAddress("245 Park Ave", "245 Park Ave", null, null)).toEqual({ lat: null, lng: null });
    expect(coordsForAddress("245 Park Ave", undefined, 40.7, -74)).toEqual({ lat: null, lng: null });
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
      tripLike({ pickupLat: PHILADELPHIA.lat, pickupLng: PHILADELPHIA.lng }),
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

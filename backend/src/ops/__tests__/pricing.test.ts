import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { db, pool } from "../../db/client";
import { affiliateZones, affiliates, trips } from "../../db/schema";
import { eq } from "drizzle-orm";
import { coverageNote, quoteTripForAffiliate } from "../pricing";
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

describe("coverageNote", () => {
  const miami = { company: "Biscayne Luxury Rides", coverageStates: ["FL"] };
  const philadelphia = { company: "Liberty Bell Executive", coverageStates: ["PA", "DE"] };

  it("cautions about licensing without pretending to know the answer", () => {
    const note = coverageNote(philadelphia, { pickupState: "NY", dropoffState: "PA" });
    expect(note).toContain("covers PA, DE");
    expect(note).toContain("pickup is in NY");
    expect(note).toContain("Operating authority is local");
    // What it must NOT do any more is call this the wrong partner. A single
    // car driving New York to Philadelphia is ordinary intercity work.
    expect(note).not.toContain("wrong partner");
  });

  it("says nothing when they work where the car is needed", () => {
    expect(coverageNote(miami, { pickupState: "FL", dropoffState: "FL" })).toBeNull();
  });

  it("points at the job they should actually be sent", () => {
    const note = coverageNote(miami, { pickupState: "NY", dropoffState: "FL" });
    expect(note).toContain("They do cover FL, where this trip ends");
  });

  it("does not caution on behalf of a partner nobody has filled in", () => {
    // An empty coverage list means nobody said, not that they cover nowhere.
    expect(
      coverageNote({ company: "New Partner", coverageStates: [] }, {
        pickupState: "NY",
        dropoffState: "NY",
      })
    ).toBeNull();
  });

  it("says nothing when the trip does not know where it starts", () => {
    expect(coverageNote(miami, { pickupState: null, dropoffState: null })).toBeNull();
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

  it("still prices a partner from another state, and says to check the licence", async () => {
    // Liberty Bell in Philadelphia, quoting a Manhattan pickup 80 miles out.
    // Their own card reaches that far, which is them saying they will travel
    // it — so the price stands and the caution rides alongside it.
    const partner = await makePartner({
      company: "Liberty Bell Executive",
      baseAddress: "Philadelphia, PA",
      baseLat: 39.9526,
      baseLng: -75.1652,
      coverageStates: ["PA", "DE"],
    });
    await db.insert(affiliateZones).values({
      affiliateId: partner.id,
      label: "Regional",
      fromMiles: 40,
      toMiles: 100,
      minimumHours: 4,
      rateCents: { SEDAN: 10_000 },
    });

    const result = await quoteTripForAffiliate(tripLike(), partner.id);
    expect(result.priced).toBe(true);
    if (!result.priced) return;
    expect(result.quote.zone.label).toBe("Regional");
    expect(result.note).toContain("Operating authority is local");
  });

  it("lets distance, not coverage, be what stops a quote", async () => {
    // Los Angeles to a Manhattan pickup. Nothing about the coverage list is
    // doing the work here — the card simply does not reach 2,447 miles, which
    // is the honest reason and the one that survives a partner who is
    // licensed in six states.
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
      toMiles: 250,
      minimumHours: 6,
      rateCents: { SEDAN: 20_000 },
    });

    const result = await quoteTripForAffiliate(tripLike(), partner.id);
    expect(result.priced).toBe(false);
    if (result.priced) return;
    expect(result.reason).toMatch(/outside every band/);
    expect(result.reason).toContain("beyond the distance they have said they will travel");
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

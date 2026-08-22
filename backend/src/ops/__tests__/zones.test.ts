import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { db, pool } from "../../db/client";
import { affiliateZones, affiliates, type VehicleClass } from "../../db/schema";
import {
  milesBetween,
  zoneForMiles,
  hourlyRateCents,
  quote,
  createZone,
  updateZone,
  deleteZone,
  listZones,
  type AffiliateZone,
} from "../zones";

afterAll(async () => {
  await pool.end();
});

/** A band as the database would hand it back, without needing the database. */
function band(over: Partial<AffiliateZone> = {}): AffiliateZone {
  return {
    id: "z1",
    affiliateId: "a1",
    label: "Metro",
    fromMiles: 0,
    toMiles: 15,
    minimumHours: 2,
    rateCents: { SEDAN: 7_500, SUV: 9_500 },
    sortOrder: 0,
    createdAt: new Date(),
    ...over,
  };
}

// --- No database needed ---------------------------------------------------

describe("milesBetween", () => {
  it("measures a distance anyone can check", () => {
    // Manhattan to Newark Liberty, about 15 miles as the crow flies.
    const miles = milesBetween(40.7580, -73.9855, 40.6895, -74.1745);
    expect(miles).toBeGreaterThan(10);
    expect(miles).toBeLessThan(18);
  });

  it("is zero for the same point, and symmetric", () => {
    expect(milesBetween(40.75, -73.98, 40.75, -73.98)).toBe(0);
    const there = milesBetween(42.36, -71.06, 40.75, -73.98);
    const back = milesBetween(40.75, -73.98, 42.36, -71.06);
    expect(there).toBeCloseTo(back, 9);
  });
});

describe("zoneForMiles", () => {
  const card = [
    band({ id: "a", label: "Metro", fromMiles: 0, toMiles: 15 }),
    band({ id: "b", label: "Suburban", fromMiles: 15, toMiles: 40 }),
    band({ id: "c", label: "Long haul", fromMiles: 40, toMiles: null }),
  ];

  it("puts a boundary in exactly one band", () => {
    // 15 belongs to Suburban, not to both. Bands run [from, to).
    expect(zoneForMiles(card, 14.9)?.label).toBe("Metro");
    expect(zoneForMiles(card, 15)?.label).toBe("Suburban");
    expect(zoneForMiles(card, 39.99)?.label).toBe("Suburban");
    expect(zoneForMiles(card, 40)?.label).toBe("Long haul");
  });

  it("lets the open-ended band catch whatever is left", () => {
    expect(zoneForMiles(card, 500)?.label).toBe("Long haul");
  });

  it("does not care what order the card arrives in", () => {
    const shuffled = [card[2], card[0], card[1]];
    expect(zoneForMiles(shuffled, 20)?.label).toBe("Suburban");
  });

  it("returns nothing when the card has a hole", () => {
    const holed = [band({ fromMiles: 0, toMiles: 10 }), band({ id: "d", fromMiles: 20, toMiles: null })];
    expect(zoneForMiles(holed, 15)).toBeNull();
  });
});

describe("hourlyRateCents", () => {
  it("gives the rate for a class the partner offers", () => {
    expect(hourlyRateCents(band(), "SEDAN")).toBe(7_500);
  });

  it("says nothing rather than zero for a class they do not run", () => {
    // A partner with no Sprinter is not a partner with a free Sprinter.
    expect(hourlyRateCents(band(), "SPRINTER" as VehicleClass)).toBeNull();
    expect(hourlyRateCents(band({ rateCents: { SEDAN: 0 } }), "SEDAN")).toBeNull();
  });
});

describe("quote", () => {
  const card = [
    band({ id: "a", label: "Metro", fromMiles: 0, toMiles: 15, minimumHours: 2, rateCents: { SEDAN: 7_500 } }),
    band({ id: "b", label: "Out of town", fromMiles: 15, toMiles: null, minimumHours: 4, rateCents: { SEDAN: 8_500, SUV: 11_000 } }),
  ];

  it("prices a straightforward job", () => {
    const q = quote(card, { miles: 5, vehicleClass: "SEDAN", hours: 3 });
    expect(q).toMatchObject({ billableHours: 3, hourlyRateCents: 7_500, totalCents: 22_500 });
    expect(q?.zone.label).toBe("Metro");
  });

  it("bills the band's minimum when the job is shorter", () => {
    // Two hours out of town still costs four: that is what the minimum means,
    // and it is the number that has to reach the invoice.
    const q = quote(card, { miles: 30, vehicleClass: "SEDAN", hours: 2 });
    expect(q?.requestedHours).toBe(2);
    expect(q?.billableHours).toBe(4);
    expect(q?.totalCents).toBe(34_000);
  });

  it("refuses to invent a price for a car they do not offer", () => {
    expect(quote(card, { miles: 30, vehicleClass: "VAN", hours: 3 })).toBeNull();
  });

  it("refuses when no band covers the distance", () => {
    const metroOnly = [card[0]];
    expect(quote(metroOnly, { miles: 90, vehicleClass: "SEDAN", hours: 3 })).toBeNull();
  });
});

// --- Database -------------------------------------------------------------

async function makeAffiliate(company = "Beacon Hill Chauffeurs") {
  const [a] = await db
    .insert(affiliates)
    .values({ company, phone: "+1 617 555 0163", email: "dispatch@beaconhill.example" })
    .returning();
  return a;
}

describe("rate card writes", () => {
  let affiliateId: string;

  beforeEach(async () => {
    await db.delete(affiliateZones);
    await db.delete(affiliates);
    affiliateId = (await makeAffiliate()).id;
  });

  const metro = { label: "Metro", fromMiles: 0, toMiles: 15, minimumHours: 2, rateCents: { SEDAN: 7_500 } };

  it("stores a band and reads it back in distance order", async () => {
    await createZone(affiliateId, { ...metro, fromMiles: 40, toMiles: null, label: "Long haul" });
    await createZone(affiliateId, metro);
    const zones = await listZones(affiliateId);
    expect(zones.map((z) => z.label)).toEqual(["Metro", "Long haul"]);
  });

  it("refuses a band that overlaps one already there, and says which", async () => {
    await createZone(affiliateId, metro);
    await expect(
      createZone(affiliateId, { ...metro, label: "Inner", fromMiles: 10, toMiles: 25 })
    ).rejects.toThrow(/overlaps "Metro" \(0–15 miles\)/);
  });

  it("lets bands sit exactly edge to edge", async () => {
    await createZone(affiliateId, metro);
    const next = await createZone(affiliateId, { ...metro, label: "Suburban", fromMiles: 15, toMiles: 40 });
    expect(next.fromMiles).toBe(15);
  });

  it("refuses a band that ends before it starts", async () => {
    await expect(
      createZone(affiliateId, { ...metro, fromMiles: 30, toMiles: 10 })
    ).rejects.toThrow(/end further out than it starts/);
  });

  it("checks an edit against the band as it will be", async () => {
    const a = await createZone(affiliateId, metro);
    await createZone(affiliateId, { ...metro, label: "Suburban", fromMiles: 15, toMiles: 40 });
    // Stretching Metro to 20 would run into Suburban.
    await expect(updateZone(a.id, { toMiles: 20 })).rejects.toThrow(/overlaps "Suburban"/);
    // Stretching it to exactly 15 is where it already ends, and is fine.
    await expect(updateZone(a.id, { toMiles: 15 })).resolves.toMatchObject({ toMiles: 15 });
  });

  it("does not count a band as overlapping itself", async () => {
    const a = await createZone(affiliateId, metro);
    await expect(updateZone(a.id, { minimumHours: 3 })).resolves.toMatchObject({ minimumHours: 3 });
  });

  it("removes a band cleanly", async () => {
    const a = await createZone(affiliateId, metro);
    await deleteZone(a.id);
    expect(await listZones(affiliateId)).toEqual([]);
    await expect(deleteZone(a.id)).rejects.toThrow(/No rate band/);
  });

  it("takes the whole card with the partner if the partner ever goes", async () => {
    await createZone(affiliateId, metro);
    await db.delete(affiliates);
    expect(await listZones(affiliateId)).toEqual([]);
  });
});

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { db, pool } from "../../db/client";
import { affiliateZones, affiliates, type VehicleClass } from "../../db/schema";
import { z } from "zod";
import {
  MAX_BAND_MINIMUM_HOURS,
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

// --- The schema in front of the pricing -----------------------------------
//
// The arithmetic in this file held up under attack. What did not was the shape
// of the request reaching it: a rename wiped every price on a band, and a typo
// in a rate box deleted a class. Both were invisible, because quote() then
// correctly refuses rather than guessing — so the partner simply became
// unpriceable and nothing said why.
//
// These rebuild the route's schemas rather than importing them, because
// importing ops.routes.ts drags in the database. Keep them in step; if they
// drift, the test is guarding a shape nothing uses.

const rate = z
  .number("A rate has to be a number.")
  .int("A rate is in whole cents.")
  .min(1, "A rate of nothing is not a rate — leave it blank if they do not offer it.")
  .optional();

const rateCentsSchema = z.strictObject({ SEDAN: rate, SUV: rate, VAN: rate, SPRINTER: rate });

const zoneFields = {
  label: z.string().min(1),
  fromMiles: z.coerce.number().int().min(0).max(1000),
  toMiles: z.coerce.number().int().min(1).max(1000).nullable(),
  minimumHours: z.coerce.number().int().min(1).max(MAX_BAND_MINIMUM_HOURS),
  rateCents: rateCentsSchema,
};

const zoneSchema = z.object({
  ...zoneFields,
  toMiles: zoneFields.toMiles.optional().default(null),
  minimumHours: zoneFields.minimumHours.default(2),
  rateCents: zoneFields.rateCents.default({}),
});

const zonePatchSchema = z.object(zoneFields).partial();

describe("patching a band changes only what was sent", () => {
  it("does not smuggle defaults in behind a rename", () => {
    // `.partial()` does not strip `.default()`. Renaming a band used to send
    // rateCents {}, minimumHours 2 and toMiles null along with the new label —
    // wiping every price, resetting the minimum, and turning a 0-15 band into
    // 0-and-everything.
    const patch = zonePatchSchema.parse({ label: "Metro" });
    expect(patch).toEqual({ label: "Metro" });
    expect("rateCents" in patch).toBe(false);
    expect("minimumHours" in patch).toBe(false);
    expect("toMiles" in patch).toBe(false);
  });

  it("still lets a band be deliberately opened at the far end", () => {
    // An explicit null is a change; an absent field is not. updateZone tells
    // them apart, so the schema has to keep the difference.
    expect(zonePatchSchema.parse({ toMiles: null })).toEqual({ toMiles: null });
  });

  it("keeps the defaults where they belong, on creating a band", () => {
    const created = zoneSchema.parse({ label: "Metro", fromMiles: 0, rateCents: { SEDAN: 7500 } });
    expect(created.minimumHours).toBe(2);
    expect(created.toMiles).toBeNull();
  });
});

describe("a rate is a price or it is absent", () => {
  it("refuses what a typo turns into", () => {
    // "9o" -> NaN -> null over the wire. Coercion read that as 0, which
    // hourlyRateCents reads as "does not offer it", so the class disappeared
    // from the card and nothing said so.
    expect(rateCentsSchema.safeParse({ SEDAN: null }).success).toBe(false);
    expect(rateCentsSchema.safeParse({ SEDAN: Number.NaN }).success).toBe(false);
    expect(rateCentsSchema.safeParse({ SEDAN: "9o" }).success).toBe(false);
  });

  it("refuses zero, which looked like a price and meant the opposite", () => {
    expect(rateCentsSchema.safeParse({ SEDAN: 0 }).success).toBe(false);
  });

  it("takes a real rate, and takes silence for an answer", () => {
    expect(rateCentsSchema.parse({ SEDAN: 7_500 })).toEqual({ SEDAN: 7_500 });
    expect(rateCentsSchema.parse({})).toEqual({});
  });

  it("refuses a class nobody has heard of", () => {
    expect(rateCentsSchema.safeParse({ LIMO: 9_000 }).success).toBe(false);
  });
});

describe("the minimum has a ceiling", () => {
  let affiliateId: string;
  beforeEach(async () => {
    await db.delete(affiliateZones);
    await db.delete(affiliates);
    affiliateId = (await makeAffiliate()).id;
  });

  const band = { label: "Metro", fromMiles: 0, toMiles: 15, rateCents: { SEDAN: 7_500 } };

  it("refuses a minimum longer than a day, wherever it comes from", async () => {
    // 20 instead of 2 quoted a three-hour job at twenty hours, and every check
    // passed. MAX_SHIFT_HOURS guards this exact typo for shifts.
    expect(zoneFields.minimumHours.safeParse(20).success).toBe(false);
    await expect(
      createZone(affiliateId, { ...band, minimumHours: 48 })
    ).rejects.toThrow(/longer than half a day/);
  });

  it("still allows the longest minimum a real card uses", async () => {
    // The seed's longest is six hours, on the long-haul band.
    const made = await createZone(affiliateId, { ...band, minimumHours: 6 });
    expect(made.minimumHours).toBe(6);
  });

  it("allows a genuinely long minimum up to the ceiling", async () => {
    const made = await createZone(affiliateId, { ...band, minimumHours: MAX_BAND_MINIMUM_HOURS });
    expect(made.minimumHours).toBe(MAX_BAND_MINIMUM_HOURS);
  });
});

describe("two people editing one card", () => {
  let affiliateId: string;
  beforeEach(async () => {
    await db.delete(affiliateZones);
    await db.delete(affiliates);
    affiliateId = (await makeAffiliate()).id;
  });

  it("does not let two overlapping bands be added at the same moment", async () => {
    // assertBandFits reads the other bands and then writes. Two adds landing
    // together both passed, leaving a card with two bands claiming the same
    // miles — the exact state the check exists to prevent.
    // Six at once, all claiming miles the others claim.
    //
    // Honest limitation: this does NOT reproduce the race. It passes against
    // the unlocked version too, because Postgres on localhost answers in under
    // a millisecond and the six calls end up effectively serial. Against Neon,
    // where every round trip is tens of milliseconds, the window between the
    // check and the write is wide open — which is where it matters and where
    // it cannot be tested from here.
    //
    // So this is a regression guard, not a proof: with the lock it must always
    // hold, and if somebody removes the lock it will start failing the moment
    // the timing does cooperate.
    const results = await Promise.allSettled(
      [0, 2, 4, 6, 8, 10].map((from, i) =>
        createZone(affiliateId, {
          label: `Band ${i}`, fromMiles: from, toMiles: from + 20,
          minimumHours: 2, rateCents: { SEDAN: 7_500 },
        })
      )
    );

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await listZones(affiliateId)).toHaveLength(1);
  });

  it("still lets bands that do not overlap go in together", async () => {
    const results = await Promise.allSettled([
      createZone(affiliateId, {
        label: "Metro", fromMiles: 0, toMiles: 15, minimumHours: 2, rateCents: { SEDAN: 7_500 },
      }),
      createZone(affiliateId, {
        label: "Suburban", fromMiles: 15, toMiles: 40, minimumHours: 3, rateCents: { SEDAN: 8_500 },
      }),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect((await listZones(affiliateId)).map((z) => z.label)).toEqual(["Metro", "Suburban"]);
  });
});

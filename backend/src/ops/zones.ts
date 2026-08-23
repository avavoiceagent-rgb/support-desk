// Partner rate cards: what a partner charges, by how far out the job goes.
//
// A partner quotes from a sheet, and the sheet is a grid — how far from their
// base, and what size of car. This holds that grid, and answers the only
// question the desk ever asks of it: "we need an SUV, 30 miles out, for three
// hours — what does that cost, and will they bill us for more than three?"
//
// Distance bands rather than named neighbourhoods, because a mileage is
// arithmetic and a neighbourhood is a judgement. "Which zone is 1 Hotel
// Brooklyn Bridge in?" needs a person the first time and every time after.

import { and, asc, eq, ne, sql } from "drizzle-orm";
import { db } from "../db/client";
import { affiliateZones, affiliates, type VehicleClass } from "../db/schema";
import { OpsError } from "./errors";

export type AffiliateZone = typeof affiliateZones.$inferSelect;

/** Nobody's partner network reaches further than this; past it, it's a typo. */
export const MAX_BAND_MILES = 1_000;

/**
 * The longest a band's minimum can be.
 *
 * There was no ceiling, so a minimum typed as 20 instead of 2 quoted a
 * three-hour job at twenty hours and every check passed.
 *
 * Twelve, not the 24 that `MAX_SHIFT_HOURS` uses. A shift and a billing
 * minimum are different things: a driver can legitimately work eleven hours,
 * but a *minimum* longer than half a day is a day rate somebody has typed into
 * the wrong box. Set at 24 this constant would have let the very typo it exists
 * to catch straight through — which is what the test found.
 */
export const MAX_BAND_MINIMUM_HOURS = 12;

const EARTH_RADIUS_MILES = 3_958.8;

/**
 * Straight-line miles between two points.
 *
 * Deliberately not driving distance. A rate band is a commercial boundary the
 * partner drew on a map, not a route: they charge the same for thirty miles
 * up the parkway as for thirty miles through town, and asking the Routes API
 * per quote would spend money to get a less appropriate answer.
 */
export function milesBetween(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * The band a distance falls in.
 *
 * Bands run [from, to): the lower bound is included and the upper is not, so
 * a card of 0-15 and 15-40 has exactly one home for a job at fifteen miles.
 * A null `toMiles` is the last band and catches everything beyond.
 */
export function zoneForMiles(zones: AffiliateZone[], miles: number): AffiliateZone | null {
  const ordered = [...zones].sort((a, b) => a.fromMiles - b.fromMiles);
  return (
    ordered.find((z) => miles >= z.fromMiles && (z.toMiles === null || miles < z.toMiles)) ?? null
  );
}

/**
 * What this band charges for this size of car, or null if they do not offer it.
 *
 * A class absent from the card means they do not run it out there. Zero used
 * to mean the same thing here while looking like a price everywhere else,
 * which made the distinction the schema comment draws impossible to express —
 * so a rate of zero is now refused at the route and cannot reach this.
 */
export function hourlyRateCents(zone: AffiliateZone, vehicleClass: VehicleClass): number | null {
  const rate = zone.rateCents?.[vehicleClass];
  return typeof rate === "number" && rate > 0 ? rate : null;
}

export interface Quote {
  zone: AffiliateZone;
  hourlyRateCents: number;
  /** What we asked for. */
  requestedHours: number;
  /** What they will actually bill, once the band's minimum is applied. */
  billableHours: number;
  totalCents: number;
}

/**
 * The price, or null when this partner cannot price this job.
 *
 * Null rather than a fallback number on purpose. A quote invented because the
 * card had no answer is exactly the kind of confident wrong figure that ends
 * up in an email to a customer.
 */
export function quote(
  zones: AffiliateZone[],
  params: { miles: number; vehicleClass: VehicleClass; hours: number }
): Quote | null {
  const zone = zoneForMiles(zones, params.miles);
  if (!zone) return null;

  const rate = hourlyRateCents(zone, params.vehicleClass);
  if (rate === null) return null;

  const billableHours = Math.max(params.hours, zone.minimumHours);
  return {
    zone,
    hourlyRateCents: rate,
    requestedHours: params.hours,
    billableHours,
    totalCents: billableHours * rate,
  };
}

// --- Reads and writes -----------------------------------------------------

export async function listZones(affiliateId: string): Promise<AffiliateZone[]> {
  return db
    .select()
    .from(affiliateZones)
    .where(eq(affiliateZones.affiliateId, affiliateId))
    .orderBy(asc(affiliateZones.fromMiles));
}

export interface ZoneInput {
  label: string;
  fromMiles: number;
  toMiles: number | null;
  minimumHours: number;
  rateCents: Partial<Record<VehicleClass, number>>;
}

/**
 * The rules a band has to satisfy, checked against its neighbours.
 *
 * Overlaps are refused rather than resolved by picking the first match. Two
 * bands both claiming twenty miles means somebody typed the card wrong, and a
 * quote that silently picks one of them is a bill nobody can explain later.
 */
async function assertBandFits(
  affiliateId: string,
  input: ZoneInput,
  excludeId?: string,
  client: Pick<typeof db, "select"> = db
) {
  if (input.fromMiles < 0) throw new OpsError("A band cannot start below zero miles.");
  if (input.toMiles !== null && input.toMiles <= input.fromMiles) {
    throw new OpsError("A band has to end further out than it starts.");
  }
  if ((input.toMiles ?? 0) > MAX_BAND_MILES || input.fromMiles > MAX_BAND_MILES) {
    throw new OpsError(`Bands stop at ${MAX_BAND_MILES} miles — check the numbers.`);
  }
  if (input.minimumHours < 1) throw new OpsError("A minimum of less than an hour is not a minimum.");
  if (input.minimumHours > MAX_BAND_MINIMUM_HOURS) {
    throw new OpsError(
      `A minimum of ${input.minimumHours} hours is longer than half a day. The most a band can ask for is ${MAX_BAND_MINIMUM_HOURS} — check the number.`
    );
  }

  const existing = await client
    .select()
    .from(affiliateZones)
    .where(
      excludeId
        ? and(eq(affiliateZones.affiliateId, affiliateId), ne(affiliateZones.id, excludeId))
        : eq(affiliateZones.affiliateId, affiliateId)
    );

  const end = input.toMiles ?? Number.POSITIVE_INFINITY;
  const clash = existing.find((z) => {
    const zEnd = z.toMiles ?? Number.POSITIVE_INFINITY;
    return input.fromMiles < zEnd && z.fromMiles < end;
  });
  if (clash) {
    const range = clash.toMiles === null ? `${clash.fromMiles}+ miles` : `${clash.fromMiles}–${clash.toMiles} miles`;
    throw new OpsError(`That overlaps "${clash.label}" (${range}). Bands cannot cover the same distance twice.`);
  }
}

async function requireAffiliate(affiliateId: string) {
  const [row] = await db.select().from(affiliates).where(eq(affiliates.id, affiliateId)).limit(1);
  if (!row) throw new OpsError(`No partner with id ${affiliateId}.`, 404);
  return row;
}

/**
 * Edits to one partner's card, one at a time.
 *
 * `assertBandFits` reads the other bands and then writes, which two people
 * adding a band together both pass — leaving a card with two bands claiming
 * the same miles, the exact state the check exists to prevent. Locking the
 * partner's row makes the read-then-write one thing.
 *
 * A row lock rather than a constraint because the rule is about ranges
 * overlapping, which no unique index expresses; Postgres has an EXCLUDE
 * constraint for it, but that needs an extension enabled on the live database
 * and this does not.
 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function withCardLocked<T>(
  affiliateId: string,
  work: (tx: Tx) => Promise<T>
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select 1 from affiliates where id = ${affiliateId} for update`);
    // Everything inside runs on `tx`, not on `db`. Reaching for the pool here
    // would take a second connection while this transaction holds the first
    // and the lock — which is not a slower version of the same thing, it is a
    // deadlock waiting for a busy afternoon. The first draft of this did
    // exactly that and hung the test run.
    return work(tx);
  });
}

export async function createZone(affiliateId: string, input: ZoneInput): Promise<AffiliateZone> {
  await requireAffiliate(affiliateId);
  return withCardLocked(affiliateId, async (tx) => {
    await assertBandFits(affiliateId, input, undefined, tx);
    const [row] = await tx
      .insert(affiliateZones)
      .values({ ...input, affiliateId, sortOrder: input.fromMiles })
      .returning();
    return row;
  });
}

export async function updateZone(id: string, patch: Partial<ZoneInput>): Promise<AffiliateZone> {
  const [existing] = await db.select().from(affiliateZones).where(eq(affiliateZones.id, id)).limit(1);
  if (!existing) throw new OpsError(`No rate band with id ${id}.`, 404);

  // Checked as it will be, not as it was: moving only the far edge still has
  // to leave a band that makes sense against the near one.
  const merged: ZoneInput = {
    label: patch.label ?? existing.label,
    fromMiles: patch.fromMiles ?? existing.fromMiles,
    toMiles: patch.toMiles === undefined ? existing.toMiles : patch.toMiles,
    minimumHours: patch.minimumHours ?? existing.minimumHours,
    rateCents: patch.rateCents ?? existing.rateCents,
  };
  return withCardLocked(existing.affiliateId, async (tx) => {
    await assertBandFits(existing.affiliateId, merged, id, tx);

    const [row] = await tx
      .update(affiliateZones)
      .set({ ...merged, sortOrder: merged.fromMiles })
      .where(eq(affiliateZones.id, id))
      .returning();
    return row;
  });
}

/**
 * Bands really are deleted, unlike drivers and partners.
 *
 * Nothing points at one — a quote is worked out from whatever the card says
 * at the time and the number is written onto the invoice — so removing a band
 * leaves no hole in the history.
 */
export async function deleteZone(id: string): Promise<AffiliateZone> {
  const [row] = await db.delete(affiliateZones).where(eq(affiliateZones.id, id)).returning();
  if (!row) throw new OpsError(`No rate band with id ${id}.`, 404);
  return row;
}

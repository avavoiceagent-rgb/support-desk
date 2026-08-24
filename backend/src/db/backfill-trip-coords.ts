// One-off: give the already-seeded trips the coordinates they were created
// without.
//
// Migration 0015 added the columns, and everything created from an email
// since then fills them from the geocode the draft already did. The dummy
// data predates all of that, so without this every seeded job answers "no
// coordinates" when a partner quote is asked for, and a working feature looks
// broken on the only data there is to look at.
//
// A backfill rather than `seed-ops --reset`, because a reset would delete the
// real reservations made from real tickets, and their history with them.
//
// Fills the state each end is in as well, from the same table — it comes from
// the same place a geocode would put it, and a partner's coverage is written
// in state codes.
//
// Only fills nulls, only where the address is exactly one the seed wrote, and
// safe to run twice. Run it with:
//
//     node backend/dist/db/backfill-trip-coords.js

import { and, eq, isNull, or, sql } from "drizzle-orm";
import { db, pool } from "./client";
import { trips } from "./schema";
import { AIRPORTS, OUT_OF_AREA, PICKUPS } from "./seed-ops";

const PLACES = [...PICKUPS, ...AIRPORTS, ...OUT_OF_AREA];

export async function backfillTripCoordinates(): Promise<{ pickups: number; dropoffs: number }> {
  let pickups = 0;
  let dropoffs = 0;

  for (const place of PLACES) {
    const asPickup = await db
      .update(trips)
      .set({ pickupLat: place.lat, pickupLng: place.lng, pickupState: place.state })
      // Either half missing is worth filling. Checking only the coordinate
      // meant a second run — the one that came after the state columns were
      // added — matched nothing and quietly left every state null.
      .where(
        and(
          eq(trips.pickupAddress, place.address),
          or(isNull(trips.pickupLat), isNull(trips.pickupState))
        )
      )
      .returning({ id: trips.id });
    pickups += asPickup.length;

    const asDropoff = await db
      .update(trips)
      .set({ dropoffLat: place.lat, dropoffLng: place.lng, dropoffState: place.state })
      .where(
        and(
          eq(trips.dropoffAddress, place.address),
          or(isNull(trips.dropoffLat), isNull(trips.dropoffState))
        )
      )
      .returning({ id: trips.id });
    dropoffs += asDropoff.length;
  }

  return { pickups, dropoffs };
}

if (require.main === module) {
  backfillTripCoordinates()
    .then(async ({ pickups, dropoffs }) => {
      const [{ remaining }] = await db
        .select({ remaining: sql<number>`count(*)::int` })
        .from(trips)
        .where(or(isNull(trips.pickupLat), isNull(trips.pickupState)));
      console.log(`Filled ${pickups} pickups and ${dropoffs} drop-offs.`);
      // Anything left is a trip whose address the seed never wrote — a real
      // booking made before the coordinates existed. Those stay unpriceable
      // by card, which is the honest answer for them.
      console.log(`${remaining} trips still have no pickup coordinates or state.`);
      await pool.end();
    })
    .catch(async (err) => {
      console.error(err);
      await pool.end();
      process.exit(1);
    });
}

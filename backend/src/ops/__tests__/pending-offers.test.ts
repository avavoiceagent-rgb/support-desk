import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { db, pool } from "../../db/client";
import {
  affiliates, dispatchMessages, driverShifts, drivers, invoiceLines, invoices,
  tripEvents, trips, users, vehicles,
} from "../../db/schema";
import { pendingOfferCounts, respondToOffer, sendOffer, sendText } from "../dispatch";
import { actorFor } from "../trip-events";

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await db.delete(dispatchMessages);
  await db.delete(tripEvents);
  await db.delete(invoiceLines);
  await db.delete(invoices);
  await db.delete(trips);
  await db.delete(driverShifts);
  await db.delete(drivers);
  await db.delete(affiliates);
  await db.delete(vehicles);
  await db.delete(users);
});

async function makeTrip(reference: string) {
  const [row] = await db.insert(trips).values({
    reference, passengerName: "Apurva",
    pickupAddress: "1 Kalisa Way, Paramus, NJ 07652",
    dropoffAddress: "LaGuardia Airport (LGA), East Elmhurst, NY 11371",
    pickupAt: new Date("2026-09-03T18:00:00.000Z"), bookedHours: 3, vehicleClass: "SEDAN",
  }).returning();
  return row;
}

async function makeDriver(name: string) {
  const [d] = await db.insert(drivers).values({ name, phone: "+1 917 555 0001" }).returning();
  return d;
}

describe("pendingOfferCounts", () => {
  it("counts an offer nobody has answered", async () => {
    const driver = await makeDriver("Peter Nowicki");
    const trip = await makeTrip("T-10310");
    await sendOffer({
      contact: { kind: "DRIVER", id: driver.id },
      tripId: trip.id,
      actor: await actorFor(undefined),
    });

    const pending = await pendingOfferCounts();
    expect(pending.drivers[driver.id]).toBe(1);
  });

  it("stops counting it once they answer, either way", async () => {
    for (const accept of [true, false]) {
      await db.delete(dispatchMessages);
      const driver = await makeDriver(`Driver ${accept}`);
      const trip = await makeTrip(`T-1031${accept ? 1 : 2}`);
      const actor = await actorFor(undefined);
      const offer = await sendOffer({
        contact: { kind: "DRIVER", id: driver.id },
        tripId: trip.id,
        actor,
      });
      await respondToOffer({ offerId: offer.id, accept, actor });

      const pending = await pendingOfferCounts();
      expect(pending.drivers[driver.id], String(accept)).toBeUndefined();
    }
  });

  it("counts two outstanding offers to the same driver as two", async () => {
    const driver = await makeDriver("Peter Nowicki");
    const actor = await actorFor(undefined);
    for (const ref of ["T-10313", "T-10314"]) {
      const trip = await makeTrip(ref);
      await sendOffer({ contact: { kind: "DRIVER", id: driver.id }, tripId: trip.id, actor });
    }
    const pending = await pendingOfferCounts();
    expect(pending.drivers[driver.id]).toBe(2);
  });

  it("does not count ordinary messages", async () => {
    // A word with a driver is not something they owe an answer to.
    const driver = await makeDriver("Peter Nowicki");
    await sendText({
      contact: { kind: "DRIVER", id: driver.id },
      body: "Running ten minutes behind",
      direction: "OUT",
      actor: await actorFor(undefined),
    });
    const pending = await pendingOfferCounts();
    expect(pending.drivers).toEqual({});
  });

  it("keeps partners separate from drivers", async () => {
    const [partner] = await db.insert(affiliates).values({
      company: "Metro Overflow Group", phone: "+1 718 555 0198", email: "d@metro.example",
    }).returning();
    const trip = await makeTrip("T-10315");
    await sendOffer({
      contact: { kind: "AFFILIATE", id: partner.id },
      tripId: trip.id,
      actor: await actorFor(undefined),
    });

    const pending = await pendingOfferCounts();
    expect(pending.affiliates[partner.id]).toBe(1);
    expect(pending.drivers).toEqual({});
  });

  it("is empty when nothing is outstanding", async () => {
    expect(await pendingOfferCounts()).toEqual({ drivers: {}, affiliates: {} });
  });
});

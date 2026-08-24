import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { db, pool } from "../../db/client";
import {
  affiliateZones, affiliates, driverShifts, drivers, invoiceLines, invoices, trips, vehicles,
} from "../../db/schema";
import { eq } from "drizzle-orm";
import { candidatesForTrip } from "../candidates";
import { sendOffer, respondToOffer, sendChangeNotice } from "../dispatch";
import { actorFor } from "../trip-events";
import { updateTrip } from "../trips";
import { dispatchMessages, tripEvents, users } from "../../db/schema";
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
  await db.delete(dispatchMessages);
  await db.delete(tripEvents);
  await db.delete(invoiceLines);
  await db.delete(invoices);
  await db.delete(trips);
  await db.delete(driverShifts);
  await db.delete(drivers);
  await db.delete(affiliateZones);
  await db.delete(affiliates);
  await db.delete(vehicles);
  await db.delete(users);
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

describe("a booking that moves under the driver holding it", () => {
  /** Offer the trip to a driver and have them accept, as the desk would. */
  async function assign(tripId: string, driverId: string) {
    const actor = await actorFor(undefined);
    const offer = await sendOffer({
      contact: { kind: "DRIVER", id: driverId },
      tripId,
      actor,
    });
    await respondToOffer({ offerId: offer.id, accept: true, actor });
  }

  it("says nothing while the booking still says what they agreed to", async () => {
    const driver = await makeDriverFree("Marco Rinaldi");
    const trip = await makeTrip();
    await assign(trip.id, driver.id);

    const result = await candidatesForTrip((await findTripById(trip.id))!);
    expect(result.assignment?.name).toBe("Marco Rinaldi");
    expect(result.assignment?.toldOfLatest).toBe(true);
    expect(result.assignment?.stillAvailable).toBe(true);
  });

  it("notices when the booking changed after the last word to them", async () => {
    // The quiet failure: nothing errors, nothing looks wrong, and a car turns
    // up an hour after the customer expected it.
    const driver = await makeDriverFree("Marco Rinaldi");
    const trip = await makeTrip();
    await assign(trip.id, driver.id);

    await updateTrip(
      trip.id,
      { pickupAt: new Date(PICKUP.getTime() + 3_600_000) },
      await actorFor(undefined)
    );

    const result = await candidatesForTrip((await findTripById(trip.id))!);
    expect(result.assignment?.toldOfLatest).toBe(false);
  });

  it("is settled again once they have been told", async () => {
    const driver = await makeDriverFree("Marco Rinaldi");
    const trip = await makeTrip();
    await assign(trip.id, driver.id);
    await updateTrip(
      trip.id,
      { pickupAt: new Date(PICKUP.getTime() + 3_600_000) },
      await actorFor(undefined)
    );

    await sendChangeNotice({
      contact: { kind: "DRIVER", id: driver.id },
      tripId: trip.id,
      actor: await actorFor(undefined),
    });

    const result = await candidatesForTrip((await findTripById(trip.id))!);
    expect(result.assignment?.toldOfLatest).toBe(true);
  });

  it("does not call a driver unavailable because of the very job in hand", async () => {
    // Their own trip is on their list. Counting it as a clash would report
    // every assigned driver as lost and send the desk hunting for nobody.
    const driver = await makeDriverFree("Marco Rinaldi");
    const trip = await makeTrip();
    await assign(trip.id, driver.id);

    const result = await candidatesForTrip((await findTripById(trip.id))!);
    expect(result.assignment?.stillAvailable).toBe(true);
  });

  it("sees when the new time falls outside their shift", async () => {
    const driver = await makeDriverFree("Marco Rinaldi"); // on shift ±6h of PICKUP
    const trip = await makeTrip();
    await assign(trip.id, driver.id);

    // Moved to the following morning, long past the end of that shift.
    await updateTrip(
      trip.id,
      { pickupAt: new Date(PICKUP.getTime() + 20 * 3_600_000) },
      await actorFor(undefined)
    );

    const result = await candidatesForTrip((await findTripById(trip.id))!);
    expect(result.assignment?.stillAvailable).toBe(false);
    expect(result.assignment?.toldOfLatest).toBe(false);
  });

  it("offers somebody else for the window the booking has moved to", async () => {
    const marco = await makeDriverFree("Marco Rinaldi");
    const trip = await makeTrip();
    await assign(trip.id, marco.id);

    // Hector's shift covers the new time; Marco's does not.
    const [v] = await db.insert(vehicles).values({
      label: "Sedan H", class: "SEDAN", makeModel: "Cadillac XTS", plate: "H1",
      passengerCapacity: 3, luggageCapacity: 3,
    }).returning();
    const [hector] = await db.insert(drivers).values({
      name: "Hector Alvarez", phone: "+1 917 555 0002", defaultVehicleId: v.id,
    }).returning();
    await db.insert(driverShifts).values({
      driverId: hector.id, vehicleId: v.id,
      startsAt: new Date(PICKUP.getTime() + 14 * 3_600_000),
      endsAt: new Date(PICKUP.getTime() + 30 * 3_600_000),
    });

    await updateTrip(
      trip.id,
      { pickupAt: new Date(PICKUP.getTime() + 20 * 3_600_000) },
      await actorFor(undefined)
    );

    const result = await candidatesForTrip((await findTripById(trip.id))!);
    expect(result.assignment?.stillAvailable).toBe(false);
    expect(result.drivers.map((d) => d.name)).toEqual(["Hector Alvarez"]);
  });

  it("does not guess at a partner's diary", async () => {
    // We know our own rota. A partner's is theirs, and inventing an answer
    // would be exactly the confident wrong fact this desk avoids.
    const partner = await makeOverflowPartner("Metro Overflow Group");
    const trip = await makeTrip();
    await updateTrip(trip.id, { affiliateId: partner.id }, await actorFor(undefined));

    const result = await candidatesForTrip((await findTripById(trip.id))!);
    expect(result.assignment?.kind).toBe("AFFILIATE");
    expect(result.assignment?.stillAvailable).toBeNull();
  });

  it("says nothing is out of date when nobody was ever told", async () => {
    // Assigned by hand, never offered. There is no message to be older than
    // the booking, and "they have not been told" would be a warning about a
    // conversation that never happened.
    const driver = await makeDriverFree("Marco Rinaldi");
    const trip = await makeTrip();
    await updateTrip(trip.id, { driverId: driver.id }, await actorFor(undefined));

    const result = await candidatesForTrip((await findTripById(trip.id))!);
    expect(result.assignment?.toldOfLatest).toBeNull();
  });
});

describe("answering a change that was re-offered", () => {
  async function assignTo(tripId: string, driverId: string) {
    const actor = await actorFor(undefined);
    const offer = await sendOffer({ contact: { kind: "DRIVER", id: driverId }, tripId, actor });
    await respondToOffer({ offerId: offer.id, accept: true, actor });
  }

  it("sends the change as something the driver can answer", async () => {
    // It went out as a plain message first: "let us know if you can still
    // cover it", with no way on the screen to say either way.
    const driver = await makeDriverFree("Marco Rinaldi");
    const trip = await makeTrip();
    await assignTo(trip.id, driver.id);

    const notice = await sendChangeNotice({
      contact: { kind: "DRIVER", id: driver.id },
      tripId: trip.id,
      actor: await actorFor(undefined),
    });
    expect(notice.kind).toBe("OFFER");
  });

  it("gives the job back when they turn the change down", async () => {
    // The failure this prevents: the schedule reading as covered by somebody
    // who has just said no.
    const driver = await makeDriverFree("Marco Rinaldi");
    const trip = await makeTrip();
    await assignTo(trip.id, driver.id);
    await updateTrip(
      trip.id,
      { pickupAt: new Date(PICKUP.getTime() + 3_600_000) },
      await actorFor(undefined)
    );

    const notice = await sendChangeNotice({
      contact: { kind: "DRIVER", id: driver.id },
      tripId: trip.id,
      actor: await actorFor(undefined),
    });
    const { trip: after } = await respondToOffer({
      offerId: notice.id,
      accept: false,
      actor: await actorFor(undefined),
    });

    expect(after?.driver).toBeNull();
    expect(after?.assignedKind).toBe("UNASSIGNED");
    // And the car with them — one left attached reads as busy on the board.
    expect(after?.vehicle).toBeNull();
  });

  it("keeps the job on them when they accept the change", async () => {
    const driver = await makeDriverFree("Marco Rinaldi");
    const trip = await makeTrip();
    await assignTo(trip.id, driver.id);
    await updateTrip(
      trip.id,
      { pickupAt: new Date(PICKUP.getTime() + 3_600_000) },
      await actorFor(undefined)
    );

    const notice = await sendChangeNotice({
      contact: { kind: "DRIVER", id: driver.id },
      tripId: trip.id,
      actor: await actorFor(undefined),
    });
    await respondToOffer({ offerId: notice.id, accept: true, actor: await actorFor(undefined) });

    const result = await candidatesForTrip((await findTripById(trip.id))!);
    expect(result.assignment?.name).toBe("Marco Rinaldi");
    expect(result.assignment?.toldOfLatest).toBe(true);
  });

  it("does not take a driver off a job that was never theirs", async () => {
    // Declining an ordinary offer is not a resignation from somebody else's
    // booking. Only the holder gives it back.
    const marco = await makeDriverFree("Marco Rinaldi");
    const [v] = await db.insert(vehicles).values({
      label: "Sedan H", class: "SEDAN", makeModel: "Cadillac XTS", plate: "H2",
      passengerCapacity: 3, luggageCapacity: 3,
    }).returning();
    const [hector] = await db.insert(drivers).values({
      name: "Hector Alvarez", phone: "+1 917 555 0003", defaultVehicleId: v.id,
    }).returning();
    await db.insert(driverShifts).values({
      driverId: hector.id, vehicleId: v.id, startsAt: hoursBefore(6), endsAt: hoursAfter(6),
    });

    const trip = await makeTrip();
    await assignTo(trip.id, marco.id);

    const actor = await actorFor(undefined);
    const offer = await sendOffer({
      contact: { kind: "DRIVER", id: hector.id },
      tripId: trip.id,
      actor,
    });
    await respondToOffer({ offerId: offer.id, accept: false, actor });

    const after = await findTripById(trip.id);
    expect(after?.driver?.name).toBe("Marco Rinaldi");
  });

  it("treats a new note as something the driver needs telling", async () => {
    // Written the other way round first, on the assumption that notes are
    // housekeeping. They are not: "child seat required", "meet and greet",
    // "quiet ride" are all instructions for whoever drives. So the flag is
    // right — and the message now carries the note, which it did not.
    const driver = await makeDriverFree("Marco Rinaldi");
    const trip = await makeTrip();
    await assignTo(trip.id, driver.id);

    await updateTrip(trip.id, { notes: "Child seat required" }, await actorFor(undefined));

    const result = await candidatesForTrip((await findTripById(trip.id))!);
    expect(result.assignment?.toldOfLatest).toBe(false);
    expect(result.offerText).toContain("Child seat required");
  });
});

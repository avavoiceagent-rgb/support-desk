import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool } from "../../db/client";
import {
  affiliates, dispatchMessages, driverShifts, drivers, invoiceLines, invoices,
  tripEvents, trips, users, vehicles,
} from "../../db/schema";
import { describeOffer, listMessages, respondToOffer, sendOffer, sendText } from "../dispatch";
import { actorFor, listTripEvents } from "../trip-events";
import { selectTrips, toTripRecord } from "../lookup";

const NOW = new Date("2026-09-24T13:00:00.000Z"); // 9am in New York
const at = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000);

afterAll(async () => {
  await pool.end();
});

async function reset() {
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
}

async function makeDriver(name = "Marco Rinaldi") {
  const [d] = await db.insert(drivers).values({ name, phone: "+1 917 555 0199" }).returning();
  return d;
}

async function makeTrip(over: Partial<typeof trips.$inferInsert> = {}) {
  const [t] = await db
    .insert(trips)
    .values({
      reference: "T-10432",
      passengerName: "Ana Costa",
      pickupAddress: "230 Park Ave, New York, NY 10169",
      dropoffAddress: "JFK Terminal 4, Jamaica, NY 11430",
      pickupAt: NOW,
      bookedHours: 3,
      vehicleClass: "SEDAN",
      ...over,
    })
    .returning();
  return t;
}

async function record(id: string) {
  const rows = await selectTrips().where(eq(trips.id, id)).limit(1);
  return toTripRecord(rows[0]);
}

describe("describeOffer, on what it does not know", () => {
  beforeEach(reset);

  it("does not tell a driver there are no bags when nobody said so", async () => {
    // "0 bags" was invented from a null, and a driver reading it brings a car
    // too small for the boot it has to fill. One of the few places in this
    // system where a made-up fact leaves the building.
    const trip = await makeTrip({ passengerCount: 4, luggageCount: null });
    const text = describeOffer(await record(trip.id));
    expect(text).toContain("4 passengers, bag count not stated");
    expect(text).not.toContain("0 bags");
  });

  it("still says zero when zero is what the customer told us", async () => {
    const trip = await makeTrip({ passengerCount: 2, luggageCount: 0 });
    expect(describeOffer(await record(trip.id))).toContain("2 passengers, 0 bags");
  });

  it("does not throw away a bag count it has", async () => {
    // The whole line used to be skipped unless the passenger count was known,
    // so four bags could go unmentioned entirely.
    const trip = await makeTrip({ passengerCount: null, luggageCount: 4 });
    const text = describeOffer(await record(trip.id));
    expect(text).toContain("passengers not stated, 4 bags");
  });

  it("says nothing at all when it knows neither", async () => {
    const trip = await makeTrip({ passengerCount: null, luggageCount: null });
    const text = describeOffer(await record(trip.id));
    expect(text).not.toContain("stated");
    expect(text).not.toContain("bag");
  });

  it("counts one of something as one", async () => {
    const trip = await makeTrip({ passengerCount: 1, luggageCount: 1 });
    expect(describeOffer(await record(trip.id))).toContain("1 passenger, 1 bag");
  });
});

describe("describeOffer", () => {
  it("writes the job in New York time, with the addresses in full", async () => {
    await reset();
    const trip = await makeTrip();
    const text = describeOffer(await record(trip.id));
    // 13:00Z is 9am where the car is. A driver reading 1pm would miss it.
    expect(text).toContain("Thursday 24 Sep, 9:00 AM");
    expect(text).toContain("230 Park Ave, New York, NY 10169");
    expect(text).toContain("Ana Costa");
  });
});

describe("the thread", () => {
  beforeEach(reset);

  it("keeps one conversation per contact, oldest first", async () => {
    const marco = await makeDriver();
    const other = await makeDriver("Dimitri Petrov");
    const actor = await actorFor(undefined);
    const contact = { kind: "DRIVER" as const, id: marco.id };

    await sendText({ contact, body: "Morning", direction: "OUT", actor });
    await sendText({ contact, body: "Morning back", direction: "IN", actor });
    await sendText({ contact: { kind: "DRIVER", id: other.id }, body: "Not for Marco", direction: "OUT", actor });

    const thread = await listMessages(contact);
    expect(thread.map((m) => m.body)).toEqual(["Morning", "Morning back"]);
  });

  it("records who was standing in for the driver", async () => {
    const [user] = await db
      .insert(users)
      .values({ name: "Amar Pant", email: "amar@desk.example", passwordHash: "x", role: "ADMIN" })
      .returning();
    const marco = await makeDriver();
    const contact = { kind: "DRIVER" as const, id: marco.id };
    const actor = await actorFor(user.id);

    const out = await sendText({ contact, body: "You free at 9?", direction: "OUT", actor });
    const inbound = await sendText({ contact, body: "Yes", direction: "IN", actor });

    // Outbound is from the desk, and says who at the desk sent it.
    expect(out.authorName).toBe("Amar Pant");
    expect(out.actedByName).toBeNull();
    // Inbound reads as being from Marco, but says who actually typed it. A
    // null here would claim a real driver sent it.
    expect(inbound.authorName).toBeNull();
    expect(inbound.actedByName).toBe("Amar Pant");
  });

  it("refuses an empty message", async () => {
    const marco = await makeDriver();
    await expect(
      sendText({ contact: { kind: "DRIVER", id: marco.id }, body: "   ", direction: "OUT", actor: await actorFor(undefined) })
    ).rejects.toThrow(/not a message/);
  });
});

describe("offers", () => {
  beforeEach(reset);

  it("accepting assigns the driver and lands in the trip's history", async () => {
    const marco = await makeDriver();
    const trip = await makeTrip();
    const actor = await actorFor(undefined);

    const offer = await sendOffer({
      contact: { kind: "DRIVER", id: marco.id },
      tripId: trip.id,
      actor,
    });
    const outcome = await respondToOffer({ offerId: offer.id, accept: true, actor });

    expect(outcome.trip?.driver?.name).toBe("Marco Rinaldi");
    expect(outcome.trip?.assignedKind).toBe("DRIVER");

    const events = await listTripEvents(trip.id);
    expect(events.some((e) => e.changes.some((c) => c.field === "Driver" && c.to === "Marco Rinaldi"))).toBe(true);
  });

  it("declining leaves the job open", async () => {
    const marco = await makeDriver();
    const trip = await makeTrip();
    const actor = await actorFor(undefined);

    const offer = await sendOffer({ contact: { kind: "DRIVER", id: marco.id }, tripId: trip.id, actor });
    const outcome = await respondToOffer({ offerId: offer.id, accept: false, actor });

    expect(outcome.trip).toBeNull();
    expect((await record(trip.id)).driverId).toBeNull();
    expect(outcome.message.kind).toBe("DECLINE");
  });

  it("records nothing when accepting would double-book", async () => {
    const marco = await makeDriver();
    const actor = await actorFor(undefined);
    // Marco is already out across these hours.
    await makeTrip({ reference: "T-10433", driverId: marco.id, pickupAt: at(1), bookedHours: 3 });
    const trip = await makeTrip();

    const offer = await sendOffer({ contact: { kind: "DRIVER", id: marco.id }, tripId: trip.id, actor });
    await expect(respondToOffer({ offerId: offer.id, accept: true, actor })).rejects.toThrow(
      /already on T-10433/
    );

    // A thread showing an acceptance that never took effect is worse than one
    // showing nothing at all.
    const thread = await listMessages({ kind: "DRIVER", id: marco.id });
    expect(thread.filter((m) => m.kind === "ACCEPT")).toEqual([]);
    expect((await record(trip.id)).driverId).toBeNull();
  });

  it("answers an offer once", async () => {
    const marco = await makeDriver();
    const trip = await makeTrip();
    const actor = await actorFor(undefined);
    const offer = await sendOffer({ contact: { kind: "DRIVER", id: marco.id }, tripId: trip.id, actor });

    await respondToOffer({ offerId: offer.id, accept: false, actor });
    await expect(respondToOffer({ offerId: offer.id, accept: true, actor })).rejects.toThrow(
      /already declined/
    );
  });

  it("will not offer a cancelled job", async () => {
    const marco = await makeDriver();
    const trip = await makeTrip({ status: "CANCELLED" });
    await expect(
      sendOffer({ contact: { kind: "DRIVER", id: marco.id }, tripId: trip.id, actor: await actorFor(undefined) })
    ).rejects.toThrow(/cancelled/);
  });

  it("offers a partner the same way, and accepting farms the job out", async () => {
    const [partner] = await db
      .insert(affiliates)
      .values({ company: "Beacon Hill Chauffeurs", phone: "+1 617 555 0163", email: "d@beacon.example" })
      .returning();
    const trip = await makeTrip();
    const actor = await actorFor(undefined);

    const offer = await sendOffer({ contact: { kind: "AFFILIATE", id: partner.id }, tripId: trip.id, actor });
    const outcome = await respondToOffer({ offerId: offer.id, accept: true, actor });

    expect(outcome.trip?.affiliate?.company).toBe("Beacon Hill Chauffeurs");
    expect(outcome.trip?.assignedKind).toBe("AFFILIATE");
  });
});

describe("offering work to somebody who cannot take it", () => {
  beforeEach(reset);

  it("refuses to offer a job to a deactivated driver", async () => {
    // updateTrip already refuses to put work on a deactivated driver, so this
    // used to be sent, read, and only fail at the acceptance — after the
    // driver had been told about a job they were never going to get.
    const marco = await makeDriver();
    await db.update(drivers).set({ active: false }).where(eq(drivers.id, marco.id));
    const trip = await makeTrip();

    await expect(
      sendOffer({ contact: { kind: "DRIVER", id: marco.id }, tripId: trip.id, actor: await actorFor(undefined) })
    ).rejects.toThrow(/deactivated and cannot be offered work/);

    expect(await listMessages({ kind: "DRIVER", id: marco.id })).toEqual([]);
  });

  it("refuses to offer a job to a deactivated partner", async () => {
    const [partner] = await db
      .insert(affiliates)
      .values({ company: "Beacon Hill", phone: "1", email: "a@b.example", active: false })
      .returning();
    const trip = await makeTrip();

    await expect(
      sendOffer({ contact: { kind: "AFFILIATE", id: partner.id }, tripId: trip.id, actor: await actorFor(undefined) })
    ).rejects.toThrow(/deactivated and cannot be offered work/);
  });

  it("still lets a deactivated driver be messaged", async () => {
    // Deactivating somebody is not blocking them. "Your last invoice is paid"
    // is a message a former driver may well need.
    const marco = await makeDriver();
    await db.update(drivers).set({ active: false }).where(eq(drivers.id, marco.id));

    const sent = await sendText({
      contact: { kind: "DRIVER", id: marco.id },
      body: "Your last invoice went out today.",
      direction: "OUT",
      actor: await actorFor(undefined),
    });
    expect(sent.body).toBe("Your last invoice went out today.");
  });
});

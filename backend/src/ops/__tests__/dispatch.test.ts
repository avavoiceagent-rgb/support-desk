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

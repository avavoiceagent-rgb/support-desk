import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { db, pool } from "../../db/client";
import {
  dispatchMessages, driverShifts, drivers, emailAccounts, invoiceLines, invoices,
  messages, notes, ticketDrafts, tickets, tripEvents, trips, users, vehicles,
} from "../../db/schema";
import { eq } from "drizzle-orm";
import { getTicketDetail } from "../ticket.service";
import { sendOffer, respondToOffer } from "../../ops/dispatch";
import { updateTrip } from "../../ops/trips";
import { actorFor } from "../../ops/trip-events";

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
  await db.delete(vehicles);
  await db.delete(ticketDrafts);
  await db.delete(notes);
  await db.delete(messages);
  await db.delete(tickets);
  await db.delete(emailAccounts);
  await db.delete(users);
});

async function makeTicketWithTrip() {
  const [account] = await db.insert(emailAccounts).values({
    provider: "GMAIL", email: "support@ourcompany.example",
    encryptedRefreshToken: "x", tokenIv: "x", tokenAuthTag: "x",
  }).returning();
  const [ticket] = await db.insert(tickets).values({
    emailAccountId: account.id, subject: "Car to JFK", providerThreadId: "t1",
    requesterEmail: "daniel@example.test",
  }).returning();
  const [trip] = await db.insert(trips).values({
    reference: "T-10308", ticketId: ticket.id, passengerName: "Daniel Weiss",
    pickupAddress: "245 Park Avenue, New York, NY 10167",
    dropoffAddress: "JFK Terminal 4, Jamaica, NY 11430",
    pickupAt: new Date("2026-09-01T19:15:00.000Z"), bookedHours: 3, vehicleClass: "SEDAN",
  }).returning();
  return { ticket, trip };
}

async function makeDriver() {
  const [v] = await db.insert(vehicles).values({
    label: "SUV 1", class: "SUV", makeModel: "Escalade", plate: "S1",
    passengerCapacity: 6, luggageCapacity: 6,
  }).returning();
  const [d] = await db.insert(drivers).values({
    name: "Amrit Singh", phone: "+1 917 555 0001", defaultVehicleId: v.id,
  }).returning();
  return d;
}

describe("dispatch traffic on the ticket", () => {
  it("shows the offer and the acceptance in the ticket that caused them", async () => {
    // The two halves of one job used to live on two screens: a ticket could
    // read "nobody assigned yet" while the offer had already been accepted.
    const { ticket, trip } = await makeTicketWithTrip();
    const driver = await makeDriver();
    const actor = await actorFor(undefined);

    const offer = await sendOffer({
      contact: { kind: "DRIVER", id: driver.id },
      tripId: trip.id,
      actor,
    });
    await respondToOffer({ offerId: offer.id, accept: true, actor });

    const detail = await getTicketDetail(ticket.id);
    expect(detail?.dispatch).toHaveLength(2);

    const [sent, answer] = detail!.dispatch;
    expect(sent.kind).toBe("OFFER");
    expect(sent.direction).toBe("OUT");
    expect(sent.contactName).toBe("Amrit Singh");
    expect(sent.contactKind).toBe("DRIVER");
    // The offer body is the real message, so the ticket shows what was sent.
    expect(sent.body).toContain("245 Park Avenue");

    expect(answer.kind).toBe("ACCEPT");
    expect(answer.direction).toBe("IN");
    expect(answer.contactName).toBe("Amrit Singh");
  });

  it("puts them in the order they happened", async () => {
    const { ticket, trip } = await makeTicketWithTrip();
    const driver = await makeDriver();
    const actor = await actorFor(undefined);
    const offer = await sendOffer({
      contact: { kind: "DRIVER", id: driver.id }, tripId: trip.id, actor,
    });
    await respondToOffer({ offerId: offer.id, accept: true, actor });

    const detail = await getTicketDetail(ticket.id);
    const times = detail!.dispatch.map((d) => d.at.getTime());
    expect(times[0]).toBeLessThanOrEqual(times[1]);
  });

  it("shows the booking's own changes, not just what was said about it", async () => {
    // A ticket holding a customer asking for a later pickup used to give no
    // sign that anybody had moved it. The request and the answer belong on
    // the same page.
    const { ticket, trip } = await makeTicketWithTrip();
    await updateTrip(
      trip.id,
      { pickupAt: new Date("2026-09-01T20:15:00.000Z") },
      await actorFor(undefined)
    );

    const detail = await getTicketDetail(ticket.id);
    expect(detail?.tripEvents).toHaveLength(1);
    expect(detail?.tripEvents[0].kind).toBe("UPDATED");
    expect(detail?.tripEvents[0].changes.map((c) => c.field)).toContain("Pickup");
  });

  it("is empty for a ticket with no reservation, rather than absent", async () => {
    // The timeline maps over this. Undefined would be a crash on every
    // ordinary ticket, which is most of them.
    const [account] = await db.insert(emailAccounts).values({
      provider: "GMAIL", email: "support2@ourcompany.example",
      encryptedRefreshToken: "x", tokenIv: "x", tokenAuthTag: "x",
    }).returning();
    const [ticket] = await db.insert(tickets).values({
      emailAccountId: account.id, subject: "Just a question", providerThreadId: "t2",
    }).returning();

    const detail = await getTicketDetail(ticket.id);
    expect(detail?.dispatch).toEqual([]);
    expect(detail?.tripEvents).toEqual([]);
  });

  it("says a contact is gone rather than showing a blank name", async () => {
    const { ticket, trip } = await makeTicketWithTrip();
    const driver = await makeDriver();
    const actor = await actorFor(undefined);
    await sendOffer({ contact: { kind: "DRIVER", id: driver.id }, tripId: trip.id, actor });

    // Deleting the driver cascades the dispatch row away with it, so the
    // blank-name case has to be reached by clearing the link instead. It is
    // reachable in life too: a message whose contact was detached leaves a
    // row that still belongs in the timeline.
    await db
      .update(dispatchMessages)
      .set({ driverId: null })
      .where(eq(dispatchMessages.tripId, trip.id));

    const detail = await getTicketDetail(ticket.id);
    expect(detail?.dispatch[0].contactName).toBe("a contact no longer on file");
  });
});

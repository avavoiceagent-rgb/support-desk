import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { db, pool } from "../../db/client";
import {
  affiliates,
  driverShifts,
  drivers,
  emailAccounts,
  invoiceLines,
  invoices,
  messages,
  tickets,
  trips,
  vehicles,
} from "../../db/schema";
import { getOpsContext } from "../ops-context.service";

// Every test here needs Postgres. They cannot run on the Windows machine this
// was written on; the Cowork session runs them.

// Relative to the real clock, not a fixed date. `getOpsContext` calls
// `findTripsForEmail` without a `now`, so it asks the actual system time
// whether a trip is past or upcoming — fixtures pinned to a fixed date would
// silently all land in the future and every SENDER_RECENT case would fail.
// The offsets are whole days, so there is no boundary to race.
const NOW = new Date();
const daysFromNow = (d: number) => new Date(NOW.getTime() + d * 86_400_000);

let accountId: string;

async function makeTicketWithEmail(params: {
  subject: string;
  body: string;
  requesterEmail?: string | null;
  withMessage?: boolean;
}) {
  const [ticket] = await db
    .insert(tickets)
    .values({
      subject: params.subject,
      requesterEmail: params.requesterEmail === undefined ? "ana@customer.example" : params.requesterEmail,
      providerThreadId: `th-${Math.random().toString(36).slice(2)}`,
      emailAccountId: accountId,
      status: "OPEN",
    })
    .returning();

  if (params.withMessage !== false) {
    await db.insert(messages).values({
      ticketId: ticket.id,
      direction: "INBOUND",
      fromAddress: "Ana Costa <ana@customer.example>",
      toAddresses: [],
      ccAddresses: [],
      subject: params.subject,
      bodyHtml: `<p>${params.body}</p>`,
      bodyText: params.body,
      providerMessageId: `pm-${Math.random().toString(36).slice(2)}`,
      providerThreadId: ticket.providerThreadId,
      sentAt: NOW,
    });
  }
  return ticket;
}

async function makeTrip(over: Partial<typeof trips.$inferInsert> = {}) {
  const [t] = await db
    .insert(trips)
    .values({
      reference: "T-10432",
      passengerName: "Ana Costa",
      bookerEmail: "ana@customer.example",
      pickupAddress: "230 Park Ave, New York, NY",
      dropoffAddress: "JFK Terminal 4",
      pickupAt: daysFromNow(-2),
      bookedHours: 3,
      vehicleClass: "SEDAN",
      ...over,
    })
    .returning();
  return t;
}

beforeEach(async () => {
  await db.delete(invoiceLines);
  await db.delete(invoices);
  await db.delete(trips);
  await db.delete(driverShifts);
  await db.delete(drivers);
  await db.delete(affiliates);
  await db.delete(vehicles);
  await db.delete(messages);
  await db.delete(tickets);
  await db.delete(emailAccounts);

  const [account] = await db
    .insert(emailAccounts)
    .values({
      provider: "GMAIL",
      email: "support@ourcompany.example",
      encryptedRefreshToken: "x",
      tokenIv: "x",
      tokenAuthTag: "x",
    })
    .returning();
  accountId = account.id;
});

afterAll(async () => {
  await pool.end();
});

describe("getOpsContext", () => {
  it("finds the trip the customer named, and says that is why it is there", async () => {
    const trip = await makeTrip();
    const ticket = await makeTicketWithEmail({
      subject: "Change to T-10432",
      body: "Can we move T-10432 to 10am please?",
    });

    const context = await getOpsContext(ticket.id);
    expect(context?.quotedReferences.trips).toEqual(["T-10432"]);
    expect(context?.trips).toHaveLength(1);
    expect(context?.trips[0].reason).toBe("QUOTED_IN_EMAIL");
    expect(context?.trips[0].trip.id).toBe(trip.id);
    expect(context?.unresolvedReferences).toEqual([]);
  });

  it("brings the driver and vehicle with the trip, so the panel needs no second call", async () => {
    const [v] = await db.insert(vehicles).values({
      label: "Sedan 1", class: "SEDAN", makeModel: "Cadillac XTS", plate: "T1",
      passengerCapacity: 3, luggageCapacity: 3,
    }).returning();
    const [d] = await db.insert(drivers).values({
      name: "Marco Rinaldi", phone: "+1 917 555 0199",
    }).returning();
    await makeTrip({ driverId: d.id, vehicleId: v.id, assignedKind: "DRIVER" });
    const ticket = await makeTicketWithEmail({
      subject: "Change to T-10432",
      body: "Can we move T-10432 to 10am please?",
    });

    const context = await getOpsContext(ticket.id);
    expect(context?.trips[0].trip.driver?.name).toBe("Marco Rinaldi");
    expect(context?.trips[0].trip.vehicle?.label).toBe("Sedan 1");
  });

  it("returns an empty list, not an error, when the quoted reference is not ours", async () => {
    const ticket = await makeTicketWithEmail({
      subject: "Change to T-99999",
      body: "Can we move T-99999 to 10am please?",
    });

    const context = await getOpsContext(ticket.id);
    expect(context).not.toBeNull();
    expect(context?.trips).toEqual([]);
    // But the panel is still told they quoted something, because a customer
    // naming a booking we cannot find is worth a person noticing.
    expect(context?.quotedReferences.trips).toEqual(["T-99999"]);
    expect(context?.unresolvedReferences).toEqual(["T-99999"]);
  });

  it("falls back to the sender's own trips when they quote no reference at all", async () => {
    await makeTrip({ reference: "T-10001", pickupAt: daysFromNow(-10) });
    await makeTrip({ reference: "T-10002", pickupAt: daysFromNow(-2) });
    await makeTrip({ reference: "T-10003", pickupAt: daysFromNow(5) });
    const ticket = await makeTicketWithEmail({
      subject: "Quick question",
      body: "Do you cover Newark airport on Sundays?",
    });

    const context = await getOpsContext(ticket.id);
    expect(context?.quotedReferences).toEqual({ trips: [], invoices: [] });
    expect(context?.senderEmail).toBe("ana@customer.example");

    const byReference = Object.fromEntries(
      context!.trips.map((t) => [t.trip.reference, t.reason])
    );
    expect(byReference["T-10003"]).toBe("SENDER_UPCOMING");
    expect(byReference["T-10002"]).toBe("SENDER_RECENT");
    expect(byReference["T-10001"]).toBe("SENDER_RECENT");
  });

  it("lists a trip once when it is both quoted and the sender's latest booking", async () => {
    await makeTrip({ reference: "T-10432", pickupAt: daysFromNow(-1) });
    const ticket = await makeTicketWithEmail({
      subject: "About T-10432",
      body: "Was T-10432 charged correctly?",
    });

    const context = await getOpsContext(ticket.id);
    const forTrip = context!.trips.filter((t) => t.trip.reference === "T-10432");
    expect(forTrip).toHaveLength(1);
    // Quoting beats guessing: they named it, so say they named it.
    expect(forTrip[0].reason).toBe("QUOTED_IN_EMAIL");
  });

  it("finds a quoted invoice with its lines and the trip it bills", async () => {
    const trip = await makeTrip({ status: "COMPLETED", actualHours: 3 });
    const [inv] = await db.insert(invoices).values({
      reference: "INV-10432", tripId: trip.id,
      billToName: "Ana Costa", billToEmail: "ana@customer.example",
      issuedOn: daysFromNow(-1), status: "DISPUTED",
      subtotalCents: 28_500, totalCents: 28_500,
    }).returning();
    await db.insert(invoiceLines).values({
      invoiceId: inv.id, description: "SEDAN as directed — 3.0 hours",
      quantityTenths: 30, unitPriceCents: 9_500, amountCents: 28_500, sortOrder: 0,
    });
    const ticket = await makeTicketWithEmail({
      subject: "Billing query",
      body: "invoice 10432 charges twice, can you check?",
    });

    const context = await getOpsContext(ticket.id);
    expect(context?.invoices).toHaveLength(1);
    expect(context?.invoices[0].reason).toBe("QUOTED_IN_EMAIL");
    expect(context?.invoices[0].invoice.lines).toHaveLength(1);
    expect(context?.invoices[0].invoice.trip?.reference).toBe("T-10432");
    expect(context?.invoices[0].invoice.totalFormatted).toBe("$285.00");
  });

  it("still finds a cancelled trip the customer is asking about", async () => {
    await makeTrip({ reference: "T-10432", status: "CANCELLED" });
    const ticket = await makeTicketWithEmail({
      subject: "Charged for a cancelled trip",
      body: "Why was I charged for T-10432? I cancelled it.",
    });

    const context = await getOpsContext(ticket.id);
    expect(context?.trips[0].trip.status).toBe("CANCELLED");
  });

  it("reads the customer's own words, not our reply quoted back at them", async () => {
    await makeTrip({ reference: "T-10432" });
    await makeTrip({ reference: "T-10500", pickupAt: daysFromNow(-40), bookerEmail: "someone@else.example" });
    const ticket = await makeTicketWithEmail({
      subject: "Change of plan",
      body: "Can we move T-10432 to 10am?",
    });
    // A later outbound message mentioning a different booking must not change
    // what the customer is taken to have asked about.
    await db.insert(messages).values({
      ticketId: ticket.id,
      direction: "OUTBOUND",
      fromAddress: "support@ourcompany.example",
      toAddresses: ["ana@customer.example"],
      ccAddresses: [],
      subject: "Re: Change of plan",
      bodyHtml: "<p>Done. See also T-10500.</p>",
      bodyText: "Done. See also T-10500.",
      providerMessageId: `pm-${Math.random().toString(36).slice(2)}`,
      providerThreadId: ticket.providerThreadId,
      sentAt: daysFromNow(1),
    });

    const context = await getOpsContext(ticket.id);
    expect(context?.quotedReferences.trips).toEqual(["T-10432"]);
  });

  it("copes with a ticket that has no inbound message yet", async () => {
    const ticket = await makeTicketWithEmail({
      subject: "Manually created",
      body: "",
      withMessage: false,
    });

    const context = await getOpsContext(ticket.id);
    expect(context?.quotedReferences).toEqual({ trips: [], invoices: [] });
    expect(context?.trips).toEqual([]);
  });

  it("returns null for a ticket that does not exist", async () => {
    expect(await getOpsContext("no-such-ticket")).toBeNull();
  });

  it("looks up no history when the ticket has no requester address", async () => {
    await makeTrip();
    const ticket = await makeTicketWithEmail({
      subject: "Anonymous",
      body: "Do you cover Newark?",
      requesterEmail: null,
    });

    const context = await getOpsContext(ticket.id);
    expect(context?.senderEmail).toBeNull();
    expect(context?.trips).toEqual([]);
  });

  it("will not hand somebody else's booking to whoever quotes the number", async () => {
    // Our references start at T-10000, which is exactly the five-digit space
    // airline and hotel confirmation numbers occupy, and the extractor takes a
    // third party's label at face value. Forwarding your own Delta
    // confirmation was enough to pull a stranger's passenger name, both
    // addresses and their whole dispatch thread onto your ticket.
    await makeTrip({ bookerEmail: "daniel@somebodyelse.example" });
    const ticket = await makeTicketWithEmail({
      subject: "My flight",
      body: "Booking reference 10432 — Delta DL2801, landing at six.",
    });

    const context = await getOpsContext(ticket.id);
    expect(context?.trips).toEqual([]);
    // Treated as a reference we could not find, rather than vanishing.
    expect(context?.unresolvedReferences).toContain("T-10432");
  });

  it("still shows the sender their own booking when they quote it", async () => {
    await makeTrip({ bookerEmail: "ana@customer.example" });
    const ticket = await makeTicketWithEmail({
      subject: "Change to T-10432",
      body: "Could we move T-10432 an hour later?",
    });

    const context = await getOpsContext(ticket.id);
    expect(context?.trips.map((t) => t.trip.reference)).toContain("T-10432");
    expect(context?.trips.find((t) => t.trip.reference === "T-10432")?.reason).toBe(
      "QUOTED_IN_EMAIL"
    );
  });

  it("counts a booking as theirs when it came from a ticket they raised", async () => {
    // A booking typed straight into the Reservations screen often carries no
    // address at all. Refusing those would hide a customer's own trip from
    // their own follow-up — the guard doing damage rather than preventing it.
    const first = await makeTicketWithEmail({ subject: "Car to JFK", body: "Need a car Friday." });
    await makeTrip({ bookerEmail: null, ticketId: first.id });

    const ticket = await makeTicketWithEmail({
      subject: "Change to T-10432",
      body: "Could we move T-10432 an hour later?",
    });

    const context = await getOpsContext(ticket.id);
    expect(context?.trips.map((t) => t.trip.reference)).toContain("T-10432");
  });

  it("will not hand over an invoice billed to somebody else either", async () => {
    const trip = await makeTrip({ bookerEmail: "daniel@somebodyelse.example" });
    await db.insert(invoices).values({
      reference: "INV-10432",
      tripId: trip.id,
      billToName: "Daniel Weiss",
      billToEmail: "daniel@somebodyelse.example",
      issuedOn: daysFromNow(-1),
      subtotalCents: 114_000,
      totalCents: 114_000,
    });

    const ticket = await makeTicketWithEmail({
      subject: "Query",
      body: "About invoice 10432 — I think it is wrong.",
    });

    const context = await getOpsContext(ticket.id);
    expect(context?.invoices).toEqual([]);
    expect(context?.unresolvedReferences).toContain("INV-10432");
  });
});

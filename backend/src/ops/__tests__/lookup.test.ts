import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { db, pool } from "../../db/client";
import { affiliates, driverShifts, drivers, invoiceLines, invoices, trips, vehicles } from "../../db/schema";
import {
  findInvoiceByReference,
  findTripByReference,
  findTripsForEmail,
  formatUsd,
  normaliseReference,
} from "../lookup";

// A fixed "now", so "upcoming" and "history" never depend on the wall clock.
const NOW = new Date("2026-09-22T15:00:00.000Z");
const daysFromNow = (d: number) => new Date(NOW.getTime() + d * 86_400_000);

async function makeVehicle(over: Partial<typeof vehicles.$inferInsert> = {}) {
  const [v] = await db.insert(vehicles).values({
    label: "Sedan 1", class: "SEDAN", makeModel: "Cadillac XTS", plate: "T1",
    passengerCapacity: 3, luggageCapacity: 3, ...over,
  }).returning();
  return v;
}

async function makeDriver(name: string, over: Partial<typeof drivers.$inferInsert> = {}) {
  const [d] = await db.insert(drivers).values({
    name, phone: "+1 917 555 0142", ...over,
  }).returning();
  return d;
}

async function makeTrip(over: Partial<typeof trips.$inferInsert> = {}) {
  const [t] = await db.insert(trips).values({
    reference: "T-10432", passengerName: "Ana Costa",
    pickupAddress: "230 Park Ave, New York, NY", dropoffAddress: "JFK Terminal 4",
    pickupAt: daysFromNow(-1), bookedHours: 3,
    vehicleClass: "SEDAN", status: "SCHEDULED", assignedKind: "UNASSIGNED",
    ...over,
  }).returning();
  return t;
}

// Not a file-level beforeEach: the parsing and formatting tests at the bottom
// need no database, and shouldn't be dragged down with the ones that do.
async function resetOps() {
  await db.delete(invoiceLines);
  await db.delete(invoices);
  await db.delete(trips);
  await db.delete(driverShifts);
  await db.delete(drivers);
  await db.delete(affiliates);
  await db.delete(vehicles);
}

afterAll(async () => {
  await pool.end();
});

describe("findTripByReference", () => {
  beforeEach(resetOps);

  it("finds the same trip however the customer types the reference", async () => {
    await makeTrip();

    // All the spellings that have actually turned up in email.
    for (const typed of ["T-10432", "t-10432", "t10432", "T 10432", " 10432 ", "#10432", "T–10432"]) {
      const trip = await findTripByReference(typed);
      expect(trip?.reference, `for ${JSON.stringify(typed)}`).toBe("T-10432");
    }
  });

  it("brings the driver, vehicle and affiliate with it, so nobody needs a second query", async () => {
    const v = await makeVehicle({ label: "SUV 2", class: "SUV", plate: "T9" });
    const d = await makeDriver("Marco Rinaldi", { phone: "+1 917 555 0199" });
    const [a] = await db.insert(affiliates).values({
      company: "Liberty Bell Executive", phone: "+1 215 555 0142", email: "dispatch@libertybellexec.example",
    }).returning();
    await makeTrip({ driverId: d.id, vehicleId: v.id, affiliateId: a.id, assignedKind: "DRIVER" });

    const trip = await findTripByReference("10432");
    expect(trip?.driver).toEqual({ id: d.id, name: "Marco Rinaldi", phone: "+1 917 555 0199" });
    expect(trip?.vehicle).toEqual({ id: v.id, label: "SUV 2", class: "SUV" });
    expect(trip?.affiliate?.company).toBe("Liberty Bell Executive");
  });

  it("leaves driver, vehicle and affiliate null on an unassigned trip", async () => {
    await makeTrip();

    const trip = await findTripByReference("T-10432");
    expect(trip?.driver).toBeNull();
    expect(trip?.vehicle).toBeNull();
    expect(trip?.affiliate).toBeNull();
  });

  it("returns null for a reference that does not exist, rather than throwing", async () => {
    await makeTrip();
    expect(await findTripByReference("T-99999")).toBeNull();
    expect(await findTripByReference("")).toBeNull();
    expect(await findTripByReference("no idea sorry")).toBeNull();
  });

  it("does not answer a billing reference with a trip of the same number", async () => {
    await makeTrip();
    // "INV-10432" means the invoice. Answering it with trip 10432 would be a
    // confident wrong answer, which is worse than no answer.
    expect(await findTripByReference("INV-10432")).toBeNull();
  });

  it("still finds a cancelled trip", async () => {
    // "Why was I charged for a trip I cancelled" needs exactly this record.
    await makeTrip({ reference: "T-10500", status: "CANCELLED" });

    const trip = await findTripByReference("10500");
    expect(trip?.status).toBe("CANCELLED");
  });
});

describe("findInvoiceByReference", () => {
  beforeEach(resetOps);

  async function makeInvoiceWithLines() {
    const trip = await makeTrip({ reference: "T-10432", status: "COMPLETED", actualHours: 3 });
    const [inv] = await db.insert(invoices).values({
      reference: "INV-10432", tripId: trip.id,
      billToName: "Ana Costa", billToEmail: "ana@example.com",
      issuedOn: daysFromNow(-1), status: "DISPUTED",
      subtotalCents: 28_500, totalCents: 31_000,
      disputeNote: "Booked 3 hours, billed 4 — customer asks why.",
    }).returning();
    await db.insert(invoiceLines).values([
      { invoiceId: inv.id, description: "Gratuity", quantityTenths: 10, unitPriceCents: 2_500, amountCents: 2_500, sortOrder: 1 },
      { invoiceId: inv.id, description: "SEDAN as directed — 3.0 hours", quantityTenths: 30, unitPriceCents: 9_500, amountCents: 28_500, sortOrder: 0 },
    ]);
    return { trip, inv };
  }

  it("comes back with its lines attached, in the order they are meant to print", async () => {
    await makeInvoiceWithLines();

    const invoice = await findInvoiceByReference("INV-10432");
    expect(invoice?.lines.map((l) => l.description)).toEqual([
      "SEDAN as directed — 3.0 hours",
      "Gratuity",
    ]);
  });

  it("accepts the reference typed loosely, the same as a trip", async () => {
    await makeInvoiceWithLines();

    for (const typed of ["INV-10432", "inv10432", "INV 10432", "10432", "#10432"]) {
      const invoice = await findInvoiceByReference(typed);
      expect(invoice?.reference, `for ${JSON.stringify(typed)}`).toBe("INV-10432");
    }
  });

  it("carries the trip it bills, so the charge can be checked against the booking", async () => {
    const { trip } = await makeInvoiceWithLines();

    const invoice = await findInvoiceByReference("10432");
    expect(invoice?.trip?.id).toBe(trip.id);
    expect(invoice?.trip?.reference).toBe("T-10432");
  });

  it("reads the stored amounts and never recomputes them", async () => {
    await makeInvoiceWithLines();

    const invoice = await findInvoiceByReference("INV-10432");
    // 285.00 + 25.00 is 310.00, but the total is whatever was billed, not a
    // sum done here. If the lines and the total ever disagree, the lookup has
    // to show that rather than hide it.
    expect(invoice?.totalCents).toBe(31_000);
    expect(invoice?.totalFormatted).toBe("$310.00");
    expect(invoice?.subtotalFormatted).toBe("$285.00");
    expect(invoice?.lines[0].amountFormatted).toBe("$285.00");
  });

  it("returns null for an invoice that does not exist", async () => {
    await makeInvoiceWithLines();
    expect(await findInvoiceByReference("INV-99999")).toBeNull();
    expect(await findInvoiceByReference("not a reference")).toBeNull();
  });

  it("does not answer a trip reference with an invoice of the same number", async () => {
    await makeInvoiceWithLines();
    expect(await findInvoiceByReference("T-10432")).toBeNull();
  });
});

describe("findTripsForEmail", () => {
  beforeEach(async () => {
    await resetOps();
    await db.insert(trips).values([
      { reference: "T-1", passengerName: "Ana Costa", bookerEmail: "Ana.Costa@Example.COM", pickupAddress: "A", dropoffAddress: "B", pickupAt: daysFromNow(-30), vehicleClass: "SEDAN" },
      { reference: "T-2", passengerName: "Ana Costa", bookerEmail: "ana.costa@example.com", pickupAddress: "A", dropoffAddress: "B", pickupAt: daysFromNow(-3), vehicleClass: "SEDAN", status: "CANCELLED" },
      { reference: "T-3", passengerName: "Ana Costa", bookerEmail: "ANA.COSTA@EXAMPLE.COM", pickupAddress: "A", dropoffAddress: "B", pickupAt: daysFromNow(-1), vehicleClass: "SEDAN", status: "COMPLETED" },
      { reference: "T-4", passengerName: "Ana Costa", bookerEmail: "ana.costa@example.com", pickupAddress: "A", dropoffAddress: "B", pickupAt: daysFromNow(2), vehicleClass: "SUV" },
      { reference: "T-5", passengerName: "Ana Costa", bookerEmail: "ana.costa@example.com", pickupAddress: "A", dropoffAddress: "B", pickupAt: daysFromNow(40), vehicleClass: "SUV" },
      { reference: "T-6", passengerName: "Someone Else", bookerEmail: "other@example.com", pickupAddress: "A", dropoffAddress: "B", pickupAt: daysFromNow(-2), vehicleClass: "SEDAN" },
    ]);
  });

  it("matches the address however it was capitalised", async () => {
    const history = await findTripsForEmail("ANA.costa@Example.com", { now: NOW });
    expect(history.map((t) => t.reference)).toEqual(["T-3", "T-2", "T-1"]);
  });

  it("puts the most recent trip first when looking back", async () => {
    const history = await findTripsForEmail("ana.costa@example.com", { now: NOW });
    expect(history.map((t) => t.reference)).toEqual(["T-3", "T-2", "T-1"]);
  });

  it("puts the soonest booking first when looking forward", async () => {
    // Capped lists ordered the other way would drop the trip happening in two
    // days and keep the one forty days out.
    const soon = await findTripsForEmail("ana.costa@example.com", { upcoming: true, now: NOW });
    expect(soon.map((t) => t.reference)).toEqual(["T-4", "T-5"]);
  });

  it("bounds the window with withinDays, backwards and forwards", async () => {
    const recent = await findTripsForEmail("ana.costa@example.com", { withinDays: 7, now: NOW });
    expect(recent.map((t) => t.reference)).toEqual(["T-3", "T-2"]);

    const nextWeek = await findTripsForEmail("ana.costa@example.com", { upcoming: true, withinDays: 7, now: NOW });
    expect(nextWeek.map((t) => t.reference)).toEqual(["T-4"]);
  });

  it("keeps a cancelled trip in the history", async () => {
    const history = await findTripsForEmail("ana.costa@example.com", { now: NOW });
    expect(history.find((t) => t.reference === "T-2")?.status).toBe("CANCELLED");
  });

  it("never returns somebody else's trips", async () => {
    const history = await findTripsForEmail("ana.costa@example.com", { now: NOW });
    expect(history.map((t) => t.reference)).not.toContain("T-6");
  });

  it("returns nothing for an address we have never booked for", async () => {
    expect(await findTripsForEmail("nobody@example.com", { now: NOW })).toEqual([]);
    expect(await findTripsForEmail("  ", { now: NOW })).toEqual([]);
  });

  it("caps the list at twenty", async () => {
    await db.insert(trips).values(
      Array.from({ length: 25 }, (_, i) => ({
        reference: `T-9${String(i).padStart(2, "0")}`,
        passengerName: "Ana Costa",
        bookerEmail: "bulk@example.com",
        pickupAddress: "A", dropoffAddress: "B",
        pickupAt: daysFromNow(-(i + 1)),
        vehicleClass: "SEDAN" as const,
      }))
    );

    const history = await findTripsForEmail("bulk@example.com", { now: NOW });
    expect(history).toHaveLength(20);
    // The twenty most recent, not an arbitrary twenty.
    expect(history[0].reference).toBe("T-900");
  });
});

describe("normaliseReference", () => {
  // No database, so this one runs anywhere. It is also the only part of the
  // file that makes a judgement rather than a query, so it is the part worth
  // pinning down hardest.
  it("accepts the spellings people actually type", () => {
    for (const typed of ["T-10432", "t-10432", "t10432", "T 10432", " 10432 ", "#10432", "T–10432", "trip 10432"]) {
      expect(normaliseReference(typed, "T"), `for ${JSON.stringify(typed)}`).toBe("T-10432");
    }
    for (const typed of ["INV-10432", "inv10432", "INV 10432", "invoice 10432", "10432"]) {
      expect(normaliseReference(typed, "INV"), `for ${JSON.stringify(typed)}`).toBe("INV-10432");
    }
  });

  it("refuses the other kind's prefix instead of quietly ignoring it", () => {
    expect(normaliseReference("INV-10432", "T")).toBeNull();
    expect(normaliseReference("T-10432", "INV")).toBeNull();
  });

  it("refuses anything that is not a reference at all", () => {
    for (const junk of ["", "   ", "no idea sorry", "T-", "ABC123XYZ", "10432a", "my travel agent"]) {
      expect(normaliseReference(junk, "T"), `for ${JSON.stringify(junk)}`).toBeNull();
    }
  });

  it("takes a bare number at face value, and lets the database say no", () => {
    // A phone number or a date handed to this function does come back looking
    // like a reference. That is deliberate: the job here is to canonicalise
    // something already believed to be a reference, not to guess which numbers
    // in an email are one. Nothing is claimed until the row is found, and
    // T-19175550142 will never be found.
    expect(normaliseReference("+1 917 555 0142", "T")).toBe("T-19175550142");
    expect(normaliseReference("22/09/2026", "T")).toBe("T-22092026");
  });
});

describe("formatUsd", () => {
  it("writes cents the way a customer reads them", () => {
    expect(formatUsd(28_500)).toBe("$285.00");
    expect(formatUsd(114_000)).toBe("$1,140.00");
    expect(formatUsd(0)).toBe("$0.00");
  });
});

// Finding the thing a customer is talking about.
//
// "Can we move T-10432 to 10am", "invoice 10432 charges twice" — before any of
// that can be answered, the desk has to find the record. That is a query with
// one right answer, so it lives here in code and never goes to a model.
//
// Two things this file deliberately does NOT do:
//
//   - It never recomputes money. `chargeCents` in seed-ops.ts owns the hourly
//     arithmetic; we read `amount_cents` and format it. Two implementations of
//     the same sum is how two parts of a system start disagreeing about what a
//     customer owes.
//   - It never filters out cancelled trips. "Why was I charged for a trip I
//     cancelled" is a real email, and it needs exactly that record.

import { and, asc, desc, eq, gte, lte, sql } from "drizzle-orm";
import { db } from "../db/client";
import { affiliates, drivers, invoiceLines, invoices, trips, vehicles } from "../db/schema";

/** How many trips a history lookup will ever return. */
const MAX_HISTORY = 20;

export interface DriverContact {
  id: string;
  name: string;
  phone: string;
}

export interface VehicleSummary {
  id: string;
  label: string;
  class: string;
}

export interface AffiliateContact {
  id: string;
  company: string;
  phone: string;
  email: string;
}

/**
 * A trip with everything a reply needs already attached. A second round trip
 * to fetch the driver's phone number is a round trip somebody will skip.
 */
export type TripRecord = typeof trips.$inferSelect & {
  driver: DriverContact | null;
  vehicle: VehicleSummary | null;
  affiliate: AffiliateContact | null;
};

export interface InvoiceLineRecord {
  id: string;
  description: string;
  quantityTenths: number;
  unitPriceCents: number;
  amountCents: number;
  /** The same number as `amountCents`, written the way a customer reads it. */
  amountFormatted: string;
  sortOrder: number;
}

export type InvoiceRecord = typeof invoices.$inferSelect & {
  subtotalFormatted: string;
  totalFormatted: string;
  lines: InvoiceLineRecord[];
  /** The trip being billed, where the trip still exists. */
  trip: TripRecord | null;
};

/** Cents to "$1,140.00". Formatting only — never arithmetic. */
export function formatUsd(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

/**
 * Pull a reference out of whatever the customer typed.
 *
 * People write "T-10432", "t10432", "T 10432", "#10432" and plain "10432", and
 * all of those mean the same trip. What they do NOT mean is each other's kind:
 * "INV-10432" handed to a trip lookup is a billing reference, and answering it
 * with trip 10432 would be a confident wrong answer. So a prefix belonging to
 * the other sort is rejected rather than ignored.
 *
 * Exported because it is the only judgement in this file, and the judgement is
 * where a tolerant pattern goes wrong: a regex shipped here in August matched
 * "my travel agent" as a passenger name. It gets tested on its own.
 */
export function normaliseReference(raw: string, prefix: "T" | "INV"): string | null {
  const cleaned = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const match = cleaned.match(/^([A-Z]*)(\d+)$/);
  if (!match) return null;

  const [, letters, digits] = match;
  const allowed = prefix === "T" ? ["", "T", "TRIP"] : ["", "INV", "INVOICE"];
  if (!allowed.includes(letters)) return null;

  return `${prefix}-${digits}`;
}

/** The joined trip query, shared by every entry point below. */
function selectTrips() {
  return db
    .select({
      trip: trips,
      driverId: drivers.id,
      driverName: drivers.name,
      driverPhone: drivers.phone,
      vehicleId: vehicles.id,
      vehicleLabel: vehicles.label,
      vehicleClass: vehicles.class,
      affiliateId: affiliates.id,
      affiliateCompany: affiliates.company,
      affiliatePhone: affiliates.phone,
      affiliateEmail: affiliates.email,
    })
    .from(trips)
    .leftJoin(drivers, eq(drivers.id, trips.driverId))
    .leftJoin(vehicles, eq(vehicles.id, trips.vehicleId))
    .leftJoin(affiliates, eq(affiliates.id, trips.affiliateId));
}

type TripRow = Awaited<ReturnType<ReturnType<typeof selectTrips>["execute"]>>[number];

function toTripRecord(row: TripRow): TripRecord {
  return {
    ...row.trip,
    driver:
      row.driverId && row.driverName && row.driverPhone
        ? { id: row.driverId, name: row.driverName, phone: row.driverPhone }
        : null,
    vehicle:
      row.vehicleId && row.vehicleLabel && row.vehicleClass
        ? { id: row.vehicleId, label: row.vehicleLabel, class: row.vehicleClass }
        : null,
    affiliate:
      row.affiliateId && row.affiliateCompany && row.affiliatePhone && row.affiliateEmail
        ? {
            id: row.affiliateId,
            company: row.affiliateCompany,
            phone: row.affiliatePhone,
            email: row.affiliateEmail,
          }
        : null,
  };
}

/**
 * The trip a customer quoted, or null.
 *
 * A reference that does not exist is a normal Tuesday — somebody mistyping a
 * digit, or quoting a booking made with a different company — not an error.
 */
export async function findTripByReference(reference: string): Promise<TripRecord | null> {
  const ref = normaliseReference(reference, "T");
  if (!ref) return null;

  const rows = await selectTrips().where(eq(trips.reference, ref)).limit(1);
  return rows.length ? toTripRecord(rows[0]) : null;
}

/** The same lookup by primary key, for following an invoice to its trip. */
export async function findTripById(id: string): Promise<TripRecord | null> {
  const rows = await selectTrips().where(eq(trips.id, id)).limit(1);
  return rows.length ? toTripRecord(rows[0]) : null;
}

/**
 * The invoice a customer quoted, with its lines and the trip it bills.
 *
 * The lines are the point: "invoice 10432 charges twice" can only be answered
 * by looking at what was actually charged for.
 */
export async function findInvoiceByReference(reference: string): Promise<InvoiceRecord | null> {
  const ref = normaliseReference(reference, "INV");
  if (!ref) return null;

  const [invoice] = await db.select().from(invoices).where(eq(invoices.reference, ref)).limit(1);
  if (!invoice) return null;

  const lines = await db
    .select()
    .from(invoiceLines)
    .where(eq(invoiceLines.invoiceId, invoice.id))
    .orderBy(asc(invoiceLines.sortOrder), asc(invoiceLines.id));

  // tripId is nullable — a deleted trip leaves the invoice standing, because
  // the money is owed either way.
  const trip = invoice.tripId ? await findTripById(invoice.tripId) : null;

  return {
    ...invoice,
    subtotalFormatted: formatUsd(invoice.subtotalCents),
    totalFormatted: formatUsd(invoice.totalCents),
    lines: lines.map((l) => ({
      id: l.id,
      description: l.description,
      quantityTenths: l.quantityTenths,
      unitPriceCents: l.unitPriceCents,
      amountCents: l.amountCents,
      amountFormatted: formatUsd(l.amountCents),
      sortOrder: l.sortOrder,
    })),
    trip,
  };
}

export interface TripHistoryOptions {
  /** Bound the window: days back for history, days forward for `upcoming`. */
  withinDays?: number;
  /** Forward bookings instead of past ones. */
  upcoming?: boolean;
  /** Overridable so tests are not at the mercy of the clock. */
  now?: Date;
}

/**
 * Everything we have booked for one email address.
 *
 * Ordering differs by direction on purpose. Looking back, the newest trip is
 * the one being asked about, so history is newest first. Looking forward, the
 * next trip is the one being asked about — and because the list is capped at
 * twenty, a newest-first forward list would return the twenty furthest-away
 * bookings and silently drop the one tomorrow.
 */
export async function findTripsForEmail(
  email: string,
  options: TripHistoryOptions = {}
): Promise<TripRecord[]> {
  const address = email.trim();
  if (!address) return [];

  const now = options.now ?? new Date();
  const upcoming = options.upcoming ?? false;

  // People capitalise their own address inconsistently, and a booking taken
  // over the phone is typed by whoever answered it.
  const matchesEmail = sql`lower(${trips.bookerEmail}) = ${address.toLowerCase()}`;

  const bounds = [matchesEmail];
  if (upcoming) {
    bounds.push(gte(trips.pickupAt, now));
    if (options.withinDays !== undefined) {
      bounds.push(lte(trips.pickupAt, new Date(now.getTime() + options.withinDays * 86_400_000)));
    }
  } else {
    bounds.push(lte(trips.pickupAt, now));
    if (options.withinDays !== undefined) {
      bounds.push(gte(trips.pickupAt, new Date(now.getTime() - options.withinDays * 86_400_000)));
    }
  }

  const rows = await selectTrips()
    .where(and(...bounds))
    .orderBy(upcoming ? asc(trips.pickupAt) : desc(trips.pickupAt))
    .limit(MAX_HISTORY);

  return rows.map(toTripRecord);
}

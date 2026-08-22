// The people, cars and partners the desk dispatches with.
//
// Plain reads and writes, with one rule that is not negotiable: none of these
// is ever deleted. Trips point at drivers, vehicles and affiliates, and a trip
// whose driver row has vanished is a hole in the history somebody will one day
// need — "who drove this, and what were we charged?" Deactivating keeps the
// record readable and takes them out of every future suggestion, which is what
// "remove" actually means here.

import { asc, eq } from "drizzle-orm";
import { db } from "../db/client";
import { affiliates, drivers, vehicles } from "../db/schema";
import { OpsError } from "./errors";

export interface DriverListItem {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  licenceNumber: string | null;
  active: boolean;
  notes: string | null;
  defaultVehicle: { id: string; label: string; class: string } | null;
}

/** Everyone, active or not — the screens filter; the API does not decide. */
export async function listDrivers(): Promise<DriverListItem[]> {
  const rows = await db
    .select({
      id: drivers.id,
      name: drivers.name,
      phone: drivers.phone,
      email: drivers.email,
      licenceNumber: drivers.licenceNumber,
      active: drivers.active,
      notes: drivers.notes,
      vehicleId: vehicles.id,
      vehicleLabel: vehicles.label,
      vehicleClass: vehicles.class,
    })
    .from(drivers)
    .leftJoin(vehicles, eq(vehicles.id, drivers.defaultVehicleId))
    .orderBy(asc(drivers.name));

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    phone: r.phone,
    email: r.email,
    licenceNumber: r.licenceNumber,
    active: r.active,
    notes: r.notes,
    defaultVehicle:
      r.vehicleId && r.vehicleLabel && r.vehicleClass
        ? { id: r.vehicleId, label: r.vehicleLabel, class: r.vehicleClass }
        : null,
  }));
}

export async function listVehicles() {
  return db.select().from(vehicles).orderBy(asc(vehicles.label));
}

export async function listAffiliates() {
  return db.select().from(affiliates).orderBy(asc(affiliates.preference), asc(affiliates.company));
}

/** Exists and is usable — the check every write does before pointing at a row. */
async function requireRow<T extends { id: string }>(
  rows: Promise<T[]>,
  what: string,
  id: string
): Promise<T> {
  const [row] = await rows;
  if (!row) throw new OpsError(`No ${what} with id ${id}.`, 404);
  return row;
}

export type DriverInput = Omit<typeof drivers.$inferInsert, "id" | "createdAt">;
export type VehicleInput = Omit<typeof vehicles.$inferInsert, "id" | "createdAt">;
export type AffiliateInput = Omit<typeof affiliates.$inferInsert, "id" | "createdAt">;

export async function createDriver(input: DriverInput) {
  if (input.defaultVehicleId) {
    await requireRow(
      db.select().from(vehicles).where(eq(vehicles.id, input.defaultVehicleId)).limit(1),
      "vehicle",
      input.defaultVehicleId
    );
  }
  const [row] = await db.insert(drivers).values(input).returning();
  return row;
}

export async function updateDriver(id: string, patch: Partial<DriverInput>) {
  await requireRow(db.select().from(drivers).where(eq(drivers.id, id)).limit(1), "driver", id);
  if (patch.defaultVehicleId) {
    await requireRow(
      db.select().from(vehicles).where(eq(vehicles.id, patch.defaultVehicleId)).limit(1),
      "vehicle",
      patch.defaultVehicleId
    );
  }
  const [row] = await db.update(drivers).set(patch).where(eq(drivers.id, id)).returning();
  return row;
}

export async function createVehicle(input: VehicleInput) {
  const [row] = await db.insert(vehicles).values(input).returning();
  return row;
}

export async function updateVehicle(id: string, patch: Partial<VehicleInput>) {
  await requireRow(db.select().from(vehicles).where(eq(vehicles.id, id)).limit(1), "vehicle", id);
  const [row] = await db.update(vehicles).set(patch).where(eq(vehicles.id, id)).returning();
  return row;
}

export async function createAffiliate(input: AffiliateInput) {
  const [row] = await db.insert(affiliates).values(input).returning();
  return row;
}

export async function updateAffiliate(id: string, patch: Partial<AffiliateInput>) {
  await requireRow(
    db.select().from(affiliates).where(eq(affiliates.id, id)).limit(1),
    "affiliate",
    id
  );
  const [row] = await db.update(affiliates).set(patch).where(eq(affiliates.id, id)).returning();
  return row;
}

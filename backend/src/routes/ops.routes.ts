// The operations API: schedules, the affiliate list, and the reservations.
//
// Same split as the ticket queue — everyone signed in can look, only admins
// can change. `requireAuth` on the router, `requireAdmin` on each write.
//
// Every write funnels through `handle`, so an OpsError becomes the status and
// the message it was given. Those messages are written for a dispatcher to
// read at speed: "Marco Rinaldi is already on T-10432 (…)" rather than "409".

import { Router, type Response } from "express";
import { z } from "zod";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { param } from "../utils/params";
import { OpsError } from "../ops/errors";
import {
  listAffiliates,
  listDrivers,
  listVehicles,
  createDriver,
  updateDriver,
  createVehicle,
  updateVehicle,
  createAffiliate,
  updateAffiliate,
} from "../ops/directory";
import { getDriverSchedule, createShift, updateShift, deleteShift } from "../ops/schedule";
import { listZones, createZone, updateZone, deleteZone, MAX_BAND_MILES } from "../ops/zones";
import {
  searchTrips,
  updateTrip,
  DEFAULT_TRIP_LIMIT,
  MAX_TRIP_LIMIT,
  TRIP_SORTS,
} from "../ops/trips";

export const opsRouter = Router();
opsRouter.use(requireAuth);

/** One place where an OpsError becomes a response, so no route forgets. */
async function handle(res: Response, work: () => Promise<unknown>) {
  try {
    return await work();
  } catch (err) {
    if (err instanceof OpsError) {
      res.status(err.status).json({ error: err.message });
      return null;
    }
    throw err;
  }
}

/** Zod gives the reason; we pass its first message through rather than "Invalid input". */
function badRequest(res: Response, parsed: { error: z.ZodError }) {
  return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
}

/** ISO 8601 in, a real Date out. `offset` so "+01:00" is accepted as well as "Z". */
const isoDate = z.iso.datetime({ offset: true }).transform((v) => new Date(v));

// --- Reads ----------------------------------------------------------------

opsRouter.get("/drivers", async (_req, res) => {
  res.json({ drivers: await listDrivers() });
});

opsRouter.get("/vehicles", async (_req, res) => {
  res.json({ vehicles: await listVehicles() });
});

// Inactive partners included on purpose: the screen filters, and an admin
// needs to see a deactivated one to turn it back on.
opsRouter.get("/affiliates", async (_req, res) => {
  res.json({ affiliates: await listAffiliates() });
});

const windowSchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
});

opsRouter.get("/drivers/:id/schedule", async (req, res) => {
  const parsed = windowSchema.safeParse(req.query);
  if (!parsed.success) return badRequest(res, parsed);

  await handle(res, async () => {
    const schedule = await getDriverSchedule(param(req, "id"), parsed.data);
    if (!schedule) return res.status(404).json({ error: "Driver not found" });
    res.json(schedule);
  });
});

const tripSearchSchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  status: z.string().optional(),
  driverId: z.string().optional(),
  affiliateId: z.string().optional(),
  q: z.string().optional(),
  sort: z
    .enum(Object.keys(TRIP_SORTS) as [string, ...string[]], "That is not a column you can sort by.")
    .optional(),
  dir: z.enum(["asc", "desc"]).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_TRIP_LIMIT, `Ask for at most ${MAX_TRIP_LIMIT} reservations at a time.`)
    .optional()
    .default(DEFAULT_TRIP_LIMIT),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

opsRouter.get("/trips", async (req, res) => {
  const parsed = tripSearchSchema.safeParse(req.query);
  if (!parsed.success) return badRequest(res, parsed);
  res.json(await searchTrips(parsed.data as Parameters<typeof searchTrips>[0]));
});

// --- Shifts ---------------------------------------------------------------

const shiftBase = {
  vehicleId: z.string().nullable().optional(),
  unavailable: z.boolean().optional(),
  reason: z.string().nullable().optional(),
};

const createShiftSchema = z.object({
  driverId: z.string().min(1, "A shift needs a driver."),
  startsAt: isoDate,
  endsAt: isoDate,
  ...shiftBase,
});

const updateShiftSchema = z.object({
  driverId: z.string().optional(),
  startsAt: isoDate.optional(),
  endsAt: isoDate.optional(),
  ...shiftBase,
});

opsRouter.post("/shifts", requireAdmin, async (req, res) => {
  const parsed = createShiftSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed);
  await handle(res, async () => res.status(201).json({ shift: await createShift(parsed.data) }));
});

opsRouter.patch("/shifts/:id", requireAdmin, async (req, res) => {
  const parsed = updateShiftSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed);
  if (Object.keys(parsed.data).length === 0) {
    return res.status(400).json({ error: "Nothing to update" });
  }
  await handle(res, async () =>
    res.json({ shift: await updateShift(param(req, "id"), parsed.data) })
  );
});

opsRouter.delete("/shifts/:id", requireAdmin, async (req, res) => {
  await handle(res, async () => {
    await deleteShift(param(req, "id"));
    res.status(204).end();
  });
});

// --- Drivers, vehicles, affiliates ---------------------------------------
//
// `active: false` is how any of these is retired. There is no DELETE on
// purpose: trips point at these rows and the history has to stay readable.

const driverSchema = z.object({
  name: z.string().min(1, "A driver needs a name."),
  phone: z.string().min(1, "A driver needs a phone number."),
  email: z.string().email("That email address does not look right.").nullable().optional(),
  defaultVehicleId: z.string().nullable().optional(),
  licenceNumber: z.string().nullable().optional(),
  active: z.boolean().optional(),
  notes: z.string().nullable().optional(),
});

opsRouter.post("/drivers", requireAdmin, async (req, res) => {
  const parsed = driverSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed);
  await handle(res, async () => res.status(201).json({ driver: await createDriver(parsed.data) }));
});

opsRouter.patch("/drivers/:id", requireAdmin, async (req, res) => {
  const parsed = driverSchema.partial().safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed);
  await handle(res, async () =>
    res.json({ driver: await updateDriver(param(req, "id"), parsed.data) })
  );
});

const vehicleSchema = z.object({
  label: z.string().min(1, "A vehicle needs a label, like \"Sedan 4\"."),
  class: z.enum(["SEDAN", "SUV", "VAN", "SPRINTER"]),
  makeModel: z.string().min(1, "A vehicle needs a make and model."),
  plate: z.string().min(1, "A vehicle needs a plate."),
  passengerCapacity: z.coerce.number().int().min(1, "A vehicle carries at least one passenger."),
  luggageCapacity: z.coerce.number().int().min(0),
  active: z.boolean().optional(),
});

opsRouter.post("/vehicles", requireAdmin, async (req, res) => {
  const parsed = vehicleSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed);
  await handle(res, async () => res.status(201).json({ vehicle: await createVehicle(parsed.data) }));
});

opsRouter.patch("/vehicles/:id", requireAdmin, async (req, res) => {
  const parsed = vehicleSchema.partial().safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed);
  await handle(res, async () =>
    res.json({ vehicle: await updateVehicle(param(req, "id"), parsed.data) })
  );
});

const affiliateSchema = z.object({
  company: z.string().min(1, "A partner needs a company name."),
  contactName: z.string().nullable().optional(),
  phone: z.string().min(1, "A partner needs a phone number."),
  email: z.string().email("That email address does not look right."),
  coverageStates: z.array(z.string()).optional(),
  coverageCities: z.array(z.string()).optional(),
  overflowPartner: z.boolean().optional(),
  hourlyRateUsd: z.coerce.number().int().min(0).nullable().optional(),
  preference: z.coerce.number().int().min(1).max(5, "Preference runs from 1 to 5.").optional(),
  baseAddress: z.string().nullable().optional(),
  baseLat: z.coerce.number().min(-90).max(90).nullable().optional(),
  baseLng: z.coerce.number().min(-180).max(180).nullable().optional(),
  active: z.boolean().optional(),
  notes: z.string().nullable().optional(),
});

opsRouter.post("/affiliates", requireAdmin, async (req, res) => {
  const parsed = affiliateSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed);
  await handle(res, async () =>
    res.status(201).json({ affiliate: await createAffiliate(parsed.data) })
  );
});

opsRouter.patch("/affiliates/:id", requireAdmin, async (req, res) => {
  const parsed = affiliateSchema.partial().safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed);
  await handle(res, async () =>
    res.json({ affiliate: await updateAffiliate(param(req, "id"), parsed.data) })
  );
});

// --- Partner rate cards ---------------------------------------------------
//
// A band is [from, to) miles from the partner's base, priced per class of car,
// with the shortest it will ever be billed at. Overlaps are refused in
// ops/zones.ts rather than resolved, because two bands claiming the same
// distance is a typo and a quote that silently picks one is a bill nobody can
// explain afterwards.

// Spelled out rather than a record over the enum, so a class the partner does
// not run is simply absent — which is not the same as being priced at zero —
// and a misspelled class is rejected instead of silently stored.
const rate = z.coerce.number().int().min(0, "A rate cannot be negative.").optional();
const rateCentsSchema = z.strictObject({
  SEDAN: rate,
  SUV: rate,
  VAN: rate,
  SPRINTER: rate,
});

const zoneSchema = z.object({
  label: z.string().min(1, "A band needs a name, like \"Metro\"."),
  fromMiles: z.coerce.number().int().min(0).max(MAX_BAND_MILES),
  toMiles: z.coerce.number().int().min(1).max(MAX_BAND_MILES).nullable().optional().default(null),
  minimumHours: z.coerce.number().int().min(1, "A minimum of less than an hour is not a minimum.").default(2),
  rateCents: rateCentsSchema.default({}),
});

opsRouter.get("/affiliates/:id/zones", async (req, res) => {
  res.json({ zones: await listZones(param(req, "id")) });
});

opsRouter.post("/affiliates/:id/zones", requireAdmin, async (req, res) => {
  const parsed = zoneSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed);
  await handle(res, async () =>
    res.status(201).json({ zone: await createZone(param(req, "id"), parsed.data) })
  );
});

opsRouter.patch("/zones/:id", requireAdmin, async (req, res) => {
  const parsed = zoneSchema.partial().safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed);
  if (Object.keys(parsed.data).length === 0) {
    return res.status(400).json({ error: "Nothing to update" });
  }
  await handle(res, async () => res.json({ zone: await updateZone(param(req, "id"), parsed.data) }));
});

opsRouter.delete("/zones/:id", requireAdmin, async (req, res) => {
  await handle(res, async () => {
    await deleteZone(param(req, "id"));
    res.status(204).end();
  });
});

// --- Reservations ---------------------------------------------------------

const tripPatchSchema = z.object({
  pickupAt: isoDate.optional(),
  bookedHours: z.coerce.number().int().min(1, "A booking is at least one hour.").optional(),
  driverId: z.string().nullable().optional(),
  vehicleId: z.string().nullable().optional(),
  affiliateId: z.string().nullable().optional(),
  status: z.enum(["SCHEDULED", "IN_PROGRESS", "COMPLETED", "CANCELLED", "NO_SHOW"]).optional(),
  notes: z.string().nullable().optional(),
});

opsRouter.patch("/trips/:id", requireAdmin, async (req, res) => {
  const parsed = tripPatchSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed);
  if (Object.keys(parsed.data).length === 0) {
    return res.status(400).json({ error: "Nothing to update" });
  }
  await handle(res, async () => res.json({ trip: await updateTrip(param(req, "id"), parsed.data) }));
});

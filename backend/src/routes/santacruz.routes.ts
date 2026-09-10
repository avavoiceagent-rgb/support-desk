/**
 * The SantaCruz screens, and the door SantaCruz knocks on.
 *
 * Two routers on purpose, mounted at two different paths, because they answer
 * to two completely different callers:
 *
 * - `santacruzRouter` is for the people at the desk. Signed in to read,
 *   an admin to change anything.
 * - `santacruzOutboundRouter` is for SantaCruz itself, which has no login and
 *   never will. It presents a shared secret and can only read.
 *
 * Keeping them apart rather than ordering middleware inside one router is
 * deliberate: a route added later to the wrong half of a single router would
 * silently inherit the wrong protection, and nothing about the code would look
 * odd. Two mounts cannot make that mistake.
 */

import { Router, type Response } from "express";
import { z } from "zod";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { OpsError } from "../ops/errors";
import { param } from "../utils/params";
import { env } from "../config/env";
import { actorFor } from "../ops/trip-events";
import { TARGET_FIELDS } from "../santacruz/fields";
import {
  bookingForSantaCruz,
  connectionStatus,
  listBookings,
  listImports,
  listMapping,
  listRejections,
  replaceMapping,
  runImport,
  updateConnection,
} from "../santacruz/store";

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

function badRequest(res: Response, parsed: { error: z.ZodError }) {
  return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
}

// ---------------------------------------------------------------------------
// The desk's side
// ---------------------------------------------------------------------------

export const santacruzRouter = Router();
santacruzRouter.use(requireAuth);

/** What Adam can be told, so the mapping screen can list it without guessing. */
santacruzRouter.get("/fields", (_req, res) => {
  res.json({ fields: TARGET_FIELDS });
});

santacruzRouter.get("/connection", async (_req, res) => {
  res.json({ connection: await connectionStatus() });
});

const connectionPatchSchema = z.object({
  baseUrl: z.string().url("That does not look like a web address.").nullable().optional(),
  sourceTimeZone: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
});

santacruzRouter.patch("/connection", requireAdmin, async (req, res) => {
  const parsed = connectionPatchSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed);
  await handle(res, async () => {
    await updateConnection(parsed.data);
    res.json({ connection: await connectionStatus() });
  });
});

santacruzRouter.get("/mapping", async (_req, res) => {
  res.json({ mapping: await listMapping() });
});

const mappingSchema = z.object({
  mapping: z
    .array(
      z.object({
        sourceColumn: z.string().min(1, "A mapping row needs the SantaCruz column name."),
        targetField: z.string().min(1),
      })
    )
    .max(100),
});

santacruzRouter.put("/mapping", requireAdmin, async (req, res) => {
  const parsed = mappingSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed);
  await handle(res, async () => {
    await replaceMapping(parsed.data.mapping);
    res.json({ mapping: await listMapping() });
  });
});

/**
 * Import rows the screen has read out of a file.
 *
 * The file is parsed in the browser rather than uploaded, so nothing has to be
 * stored anywhere on the way in and a person can see what they are about to
 * import before they import it.
 */
const importSchema = z.object({
  label: z.string().max(200).optional(),
  rows: z
    .array(z.record(z.string(), z.unknown()))
    .min(1, "There were no rows in that file.")
    .max(5000, "That is more than 5,000 rows. Split the file and import it in parts."),
});

santacruzRouter.post("/import", requireAdmin, async (req, res) => {
  const parsed = importSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed);
  await handle(res, async () => {
    const outcome = await runImport({
      source: "FILE",
      label: parsed.data.label ?? null,
      rows: parsed.data.rows,
      actor: await actorFor(req.session?.userId),
    });
    res.status(201).json({ outcome });
  });
});

santacruzRouter.get("/imports", async (_req, res) => {
  res.json({ imports: await listImports() });
});

santacruzRouter.get("/imports/:id/rejections", async (req, res) => {
  res.json({ rejections: await listRejections(param(req, "id")) });
});

santacruzRouter.get("/bookings", async (req, res) => {
  const limit = Number(req.query.limit ?? 100);
  const offset = Number(req.query.offset ?? 0);
  res.json({
    bookings: await listBookings({
      limit: Number.isFinite(limit) ? limit : 100,
      offset: Number.isFinite(offset) ? offset : 0,
    }),
  });
});

// ---------------------------------------------------------------------------
// SantaCruz's side
// ---------------------------------------------------------------------------

export const santacruzOutboundRouter = Router();

/**
 * The shared secret SantaCruz presents.
 *
 * Compared in a way that takes the same time whichever character is wrong, so
 * the endpoint cannot be used to work the key out a letter at a time. Off
 * entirely until a secret is set: an endpoint with no key configured must
 * refuse everybody rather than let everybody in, which is the direction that
 * mistake has to fail in.
 */
export function keyIsRight(presented: string | undefined): boolean {
  const expected = env.SANTACRUZ_INBOUND_KEY;
  // Read here rather than from a value worked out when this file was first
  // loaded, so the answer cannot be stale — and so this is testable without
  // building a fake Express request.
  if (!expected) return false;
  const given = presented ?? "";
  if (given.length !== expected.length) return false;
  let differences = 0;
  for (let i = 0; i < expected.length; i += 1) {
    differences |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return differences === 0;
}

santacruzOutboundRouter.use((req, res, next) => {
  if (!keyIsRight(req.header("x-api-key"))) {
    res.status(401).json({ error: "Not authorised." });
    return;
  }
  next();
});

/**
 * What Adam knows about one of their bookings.
 *
 * Read only, and deliberately narrow. SantaCruz owns the booking, so its own
 * details are not handed back to it — what Adam has that they do not is the
 * conversation the booking arrived through. Sending their data back would
 * create a second copy that can disagree with the first, which is the whole
 * thing this design exists to avoid.
 */
santacruzOutboundRouter.get("/bookings/:reference", async (req, res) => {
  const booking = await bookingForSantaCruz(param(req, "reference"));
  if (!booking) {
    res.status(404).json({ error: "No booking with that reference has reached this desk." });
    return;
  }
  res.json({
    reference: booking.reference,
    externalId: booking.externalId,
    knownToDesk: true,
    firstSeenAt: booking.firstSeenAt,
    lastSeenAt: booking.lastSeenAt,
    // Null until a booking is linked to the email it came in on. Linking is
    // not guessed at from a name or an address — see the SantaCruz screen.
    ticketId: booking.ticketId,
  });
});

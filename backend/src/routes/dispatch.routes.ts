// Messages between the desk and a driver or a partner.
//
// Its own router rather than a corner of /ops, because the permission split is
// different and deliberately so. Everything under /ops is admin-only to write:
// the roster and the rate cards are administrative. Telling a driver where to
// be is the ordinary work of whoever is on dispatch, so these are open to
// anyone signed in.

import { Router, type Response } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { param } from "../utils/params";
import { OpsError } from "../ops/errors";
import { actorFor } from "../ops/trip-events";
import { listMessages, respondToOffer, sendOffer, sendText, type Contact } from "../ops/dispatch";

export const dispatchRouter = Router();
dispatchRouter.use(requireAuth);

async function handle(res: Response, work: () => Promise<unknown>) {
  try {
    return await work();
  } catch (err) {
    // These refusals are written to be read — "Marco Rinaldi is already on
    // T-10432 (22 Jul, 9:00 AM–1:00 PM)" — so they go through untouched.
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

const contactSchema = z.object({
  kind: z.enum(["DRIVER", "AFFILIATE"]),
  id: z.string().min(1),
});

function contactFrom(req: { params: Record<string, string> }): Contact {
  return { kind: req.params.kind === "AFFILIATE" ? "AFFILIATE" : "DRIVER", id: req.params.id };
}

dispatchRouter.get("/:kind/:id/messages", async (req, res) => {
  const parsed = contactSchema.safeParse({ kind: req.params.kind, id: req.params.id });
  if (!parsed.success) return badRequest(res, parsed);
  await handle(res, async () => res.json({ messages: await listMessages(parsed.data) }));
});

const textSchema = z.object({
  body: z.string().min(1, "An empty message is not a message."),
  // OUT is the desk speaking. IN is somebody here standing in for the contact
  // until drivers have links of their own.
  direction: z.enum(["OUT", "IN"]),
  tripId: z.string().nullable().optional(),
});

dispatchRouter.post("/:kind/:id/messages", async (req, res) => {
  const parsed = textSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed);
  const actor = await actorFor(req.session?.userId);
  await handle(res, async () =>
    res.status(201).json({
      message: await sendText({ contact: contactFrom(req), actor, ...parsed.data }),
    })
  );
});

const offerSchema = z.object({
  tripId: z.string().min(1, "Which job is this about?"),
  note: z.string().nullable().optional(),
});

dispatchRouter.post("/:kind/:id/offers", async (req, res) => {
  const parsed = offerSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed);
  const actor = await actorFor(req.session?.userId);
  await handle(res, async () =>
    res.status(201).json({
      message: await sendOffer({ contact: contactFrom(req), actor, ...parsed.data }),
    })
  );
});

const responseSchema = z.object({
  accept: z.boolean(),
  note: z.string().nullable().optional(),
});

dispatchRouter.post("/offers/:id/response", async (req, res) => {
  const parsed = responseSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed);
  const actor = await actorFor(req.session?.userId);
  await handle(res, async () =>
    res.status(201).json(await respondToOffer({ offerId: param(req, "id"), actor, ...parsed.data }))
  );
});

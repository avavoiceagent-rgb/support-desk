// Messages between the desk and a driver or a partner.
//
// Its own router rather than a corner of /ops, because the permission split is
// different. Everything under /ops is admin-only to write: the roster and the
// rate cards are administrative. Telling a driver where to be is the ordinary
// work of whoever is on dispatch, so reading a thread, sending a message and
// sending an offer are open to anyone signed in.
//
// Answering an offer is not. Accepting one assigns the driver — it goes
// through `updateTrip` to do it — and that is the same change `PATCH
// /ops/trips/:id` refuses without an admin session. Two calls here used to
// achieve what one call there would not, which is a hole sitting next to a
// wall rather than a considered exception.
//
// The rule, stated once so it is easy to keep: **changing a trip needs an
// admin, whichever screen you do it from.** Everything else about dispatch
// stays open.
//
// This does not stand in the way of drivers getting links of their own. A
// driver arriving on their own link is not a signed-in user at all, so their
// acceptance will come through a route that authenticates a token rather than
// a session, and this check will not be the thing in its way.

import { Router, type Response } from "express";
import { z } from "zod";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { param } from "../utils/params";
import { OpsError } from "../ops/errors";
import { actorFor } from "../ops/trip-events";
import {
  awardQuote,
  listMessages,
  pendingOfferCounts,
  quotesForTrip,
  recordQuote,
  requestQuotes,
  respondToOffer,
  sendChangeNotice,
  sendOffer,
  sendText,
  type Contact,
} from "../ops/dispatch";

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

const noteOnlySchema = z.object({ note: z.string().max(2000).optional().nullable() });

const quoteRequestSchema = noteOnlySchema.extend({
  affiliateIds: z.array(z.string().min(1)).min(1, "Choose at least one partner to ask."),
});

const quoteSchema = noteOnlySchema.extend({
  // Whole cents. A price that reaches a customer must not have travelled
  // through a float on the way.
  amountCents: z.number().int().positive("A quote needs a price."),
});

function contactFrom(req: { params: Record<string, string> }): Contact {
  return { kind: req.params.kind === "AFFILIATE" ? "AFFILIATE" : "DRIVER", id: req.params.id };
}

/**
 * Who is waiting on an answer, for the contact list to mark.
 *
 * Declared before the "/:kind/:id/..." routes: Express matches in order, and
 * "pending" would otherwise be read as a contact kind.
 */
dispatchRouter.get("/pending", async (_req, res) => {
  await handle(res, async () => res.json(await pendingOfferCounts()));
});

/**
 * Farming a job out. Declared before "/:kind/:id/..." for the same reason
 * "/pending" is: Express matches in order and would read "quotes" as a
 * contact kind.
 *
 * Asking for prices is dispatch work and open to anyone signed in — it commits
 * us to nothing, and a quote request that needed an admin would stall an
 * out-of-area job whenever the one admin was out.
 *
 * Awarding one is not. It writes money onto the trip and offers the job at
 * that price, which is the same class of change `PATCH /ops/trips/:id`
 * refuses without an admin. The rule at the top of this file — changing a
 * trip needs an admin, whichever screen you do it from — applies here.
 */
dispatchRouter.get("/quotes/:tripId", async (req, res) => {
  await handle(res, async () =>
    res.json({ quotes: await quotesForTrip(param(req, "tripId")) })
  );
});

dispatchRouter.post("/quotes/:tripId/requests", async (req, res) => {
  const parsed = quoteRequestSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed);
  const actor = await actorFor(req.session?.userId);
  await handle(res, async () =>
    res.status(201).json(
      await requestQuotes({ tripId: param(req, "tripId"), actor, ...parsed.data })
    )
  );
});

dispatchRouter.post("/quote-requests/:id/quote", async (req, res) => {
  const parsed = quoteSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed);
  const actor = await actorFor(req.session?.userId);
  await handle(res, async () =>
    res.status(201).json({
      message: await recordQuote({ requestId: param(req, "id"), actor, ...parsed.data }),
    })
  );
});

dispatchRouter.post("/quotes/:id/award", requireAdmin, async (req, res) => {
  const parsed = noteOnlySchema.safeParse(req.body ?? {});
  if (!parsed.success) return badRequest(res, parsed);
  const actor = await actorFor(req.session?.userId);
  await handle(res, async () =>
    res.status(201).json(await awardQuote({ quoteId: param(req, "id"), actor, ...parsed.data }))
  );
});

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

/**
 * Tell the driver or partner holding this job that it has changed.
 *
 * Open to anyone signed in, like sending an offer. The person who noticed the
 * booking moved is the person who should be able to say so, and needing an
 * admin to pass the message on is how a car ends up at the old time.
 */
dispatchRouter.post("/:kind/:id/change-notice", async (req, res) => {
  const parsed = offerSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed);
  const actor = await actorFor(req.session?.userId);
  await handle(res, async () =>
    res.status(201).json({
      message: await sendChangeNotice({ contact: contactFrom(req), actor, ...parsed.data }),
    })
  );
});

const responseSchema = z.object({
  accept: z.boolean(),
  note: z.string().nullable().optional(),
});

dispatchRouter.post("/offers/:id/response", requireAdmin, async (req, res) => {
  const parsed = responseSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed);
  const actor = await actorFor(req.session?.userId);
  await handle(res, async () =>
    res.status(201).json(await respondToOffer({ offerId: param(req, "id"), actor, ...parsed.data }))
  );
});

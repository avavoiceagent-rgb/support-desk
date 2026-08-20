import { Router } from "express";
import { z } from "zod";
import sanitizeHtml from "sanitize-html";
import { requireAuth } from "../middleware/auth";
import {
  listTickets,
  getTicketDetail,
  listRequesterHistory,
  updateTicket,
  createManualTicket,
  assertUserExists,
  listEmailAccountRow,
} from "../services/ticket.service";
import { getDraftForTicket, setDraftStatus } from "../services/draft.service";
import { getStats } from "../services/stats.service";
import { getReports } from "../services/reports.service";
import { ALL_STATUSES, ALL_QUEUES, ALL_RESERVATION_TYPES, ALL_RESERVATION_SOURCES } from "../types";
import type { TicketStatus, TicketQueue, ReservationType, ReservationSource } from "../types";
import { sendTicketReply, ReplyError } from "../services/reply.service";
import { addNote } from "../services/note.service";
import { decryptToken } from "../crypto/token-encryption";
import { getProvider } from "../mail/registry";
import { db } from "../db/client";
import { attachments as attachmentsTable, messages } from "../db/schema";
import { eq } from "drizzle-orm";
import { param } from "../utils/params";

export const ticketsRouter = Router();
ticketsRouter.use(requireAuth);

const statusEnum = z.enum(ALL_STATUSES as [TicketStatus, ...TicketStatus[]]);
const queueEnum = z.enum(ALL_QUEUES as [TicketQueue, ...TicketQueue[]]);
const reservationTypeEnum = z.enum(ALL_RESERVATION_TYPES as [ReservationType, ...ReservationType[]]);
const reservationSourceEnum = z.enum(
  ALL_RESERVATION_SOURCES as [ReservationSource, ...ReservationSource[]]
);

const listQuerySchema = z.object({
  status: statusEnum.optional(),
  assigneeId: z.string().optional(), // "unassigned" is a special value
});

ticketsRouter.get("/", async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Invalid query params" });
  const { status, assigneeId } = parsed.data;
  const tickets = await listTickets({
    status,
    assigneeId: assigneeId === "unassigned" ? null : assigneeId,
  });
  res.json({ tickets });
});

// Dashboard aggregates. Registered before "/:id" so "stats" isn't taken as an id.
ticketsRouter.get("/stats/overview", async (_req, res) => {
  res.json({ stats: await getStats() });
});

// Analytical reports over a date range (days=0 → all time).
ticketsRouter.get("/reports/overview", async (req, res) => {
  const days = Math.max(0, Math.min(3650, Number(req.query.days ?? 30) || 0));
  res.json({ reports: await getReports(days) });
});

const createSchema = z.object({
  subject: z.string().min(1, "Subject is required"),
  body: z.string().optional(),
  requesterName: z.string().optional(),
  requesterEmail: z.string().email("Invalid email").optional().or(z.literal("")),
  requesterPhone: z.string().optional(),
  channel: z.enum(["EMAIL", "PHONE"]),
  queue: queueEnum.nullable().optional(),
  assigneeId: z.string().nullable().optional(),
  status: statusEnum.optional(),
});

// Create a ticket by hand (e.g. from a phone call).
ticketsRouter.post("/", async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
  const d = parsed.data;
  if (!d.requesterName?.trim() && !d.requesterEmail?.trim() && !d.requesterPhone?.trim()) {
    return res.status(400).json({ error: "Add a requester name, email, or phone number." });
  }
  try {
    const ticket = await createManualTicket({
      subject: d.subject,
      body: d.body,
      requesterName: d.requesterName?.trim() || undefined,
      requesterEmail: d.requesterEmail?.trim() || undefined,
      requesterPhone: d.requesterPhone?.trim() || undefined,
      channel: d.channel,
      queue: d.queue ?? null,
      assigneeId: d.assigneeId ?? null,
      status: d.status,
    });
    res.status(201).json({ ticket });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Failed to create ticket" });
  }
});

// Other tickets from the same requester (by email or display name).
// The suggested reply, with the sign-off filled in for whoever is looking.
ticketsRouter.get("/:id/draft", async (req, res) => {
  const draft = await getDraftForTicket(param(req, "id"), req.session?.userId ?? "");
  res.json({ draft });
});

// Loaded into the composer, or set aside. Either way it stops being offered.
ticketsRouter.post("/:id/draft/:action", async (req, res) => {
  const action = param(req, "action");
  if (action !== "use" && action !== "dismiss") {
    return res.status(400).json({ error: "Unknown action" });
  }
  await setDraftStatus(param(req, "id"), action === "use" ? "USED" : "DISMISSED");
  res.status(204).end();
});

ticketsRouter.get("/:id/history", async (req, res) => {
  const history = await listRequesterHistory(param(req, "id"));
  if (history === null) return res.status(404).json({ error: "Ticket not found" });
  res.json({ history });
});

ticketsRouter.get("/:id", async (req, res) => {
  const ticket = await getTicketDetail(param(req, "id"));
  if (!ticket) return res.status(404).json({ error: "Ticket not found" });
  res.json({ ticket });
});

const updateSchema = z.object({
  status: statusEnum.optional(),
  assigneeId: z.string().nullable().optional(),
  queue: queueEnum.nullable().optional(),
  channel: z.enum(["EMAIL", "PHONE"]).optional(),
  reservationType: reservationTypeEnum.nullable().optional(),
  reservationSource: reservationSourceEnum.nullable().optional(),
});

ticketsRouter.patch("/:id", async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid input" });
  if (Object.keys(parsed.data).length === 0) {
    return res.status(400).json({ error: "Nothing to update" });
  }
  if (parsed.data.assigneeId) {
    const exists = await assertUserExists(parsed.data.assigneeId);
    if (!exists) return res.status(400).json({ error: "Assignee not found" });
  }
  const updated = await updateTicket(param(req, "id"), parsed.data);
  if (!updated) return res.status(404).json({ error: "Ticket not found" });
  res.json({ ticket: updated });
});

const replySchema = z.object({
  bodyHtml: z.string().min(1, "Reply body can't be empty"),
  cc: z.array(z.string().email()).optional(),
});

ticketsRouter.post("/:id/reply", async (req, res) => {
  const parsed = replySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
  try {
    const clean = sanitizeHtml(parsed.data.bodyHtml, {
      allowedTags: sanitizeHtml.defaults.allowedTags,
      allowedAttributes: sanitizeHtml.defaults.allowedAttributes,
    });
    const message = await sendTicketReply({
      ticketId: param(req, "id"),
      authorId: req.session!.userId,
      bodyHtml: clean,
      ccOverride: parsed.data.cc,
    });
    res.status(201).json({ message });
  } catch (err) {
    if (err instanceof ReplyError) return res.status(400).json({ error: err.message });
    console.error("[reply] failed:", err);
    res.status(502).json({ error: "Failed to send reply. Please try again." });
  }
});

const noteSchema = z.object({ body: z.string().min(1) });

ticketsRouter.post("/:id/notes", async (req, res) => {
  const parsed = noteSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Note can't be empty" });
  const note = await addNote(param(req, "id"), req.session!.userId, parsed.data.body);
  res.status(201).json({ note });
});

// GET /api/tickets/:ticketId/attachments/:attachmentId — proxy-download an
// attachment from the provider on demand (we only store metadata, per plan).
ticketsRouter.get("/:ticketId/attachments/:attachmentId", async (req, res) => {
  const [attachment] = await db
    .select()
    .from(attachmentsTable)
    .where(eq(attachmentsTable.id, param(req, "attachmentId")))
    .limit(1);
  if (!attachment) return res.status(404).json({ error: "Attachment not found" });

  const [message] = await db.select().from(messages).where(eq(messages.id, attachment.messageId)).limit(1);
  if (!message || message.ticketId !== param(req, "ticketId")) {
    return res.status(404).json({ error: "Attachment not found" });
  }

  const account = await listEmailAccountRow((await getTicketDetail(param(req, "ticketId")))?.emailAccountId ?? "");
  if (!account) return res.status(404).json({ error: "Mailbox not found" });

  const provider = getProvider(account.provider);
  const refreshToken = decryptToken({
    ciphertext: account.encryptedRefreshToken,
    iv: account.tokenIv,
    authTag: account.tokenAuthTag,
  });

  try {
    const file = await provider.getAttachment(refreshToken, message.providerMessageId, attachment.providerAttachmentId);
    res.setHeader("Content-Type", file.mimeType);
    res.setHeader("Content-Disposition", `attachment; filename="${file.filename}"`);
    res.send(file.data);
  } catch (err) {
    console.error("[attachment-download] failed:", err);
    res.status(502).json({ error: "Failed to download attachment" });
  }
});

import { Router } from "express";
import { z } from "zod";
import sanitizeHtml from "sanitize-html";
import { requireAuth } from "../middleware/auth";
import {
  listTickets,
  getTicketDetail,
  updateTicket,
  assertUserExists,
  listEmailAccountRow,
} from "../services/ticket.service";
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

const listQuerySchema = z.object({
  status: z.enum(["OPEN", "IN_PROGRESS", "CLOSED"]).optional(),
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

ticketsRouter.get("/:id", async (req, res) => {
  const ticket = await getTicketDetail(param(req, "id"));
  if (!ticket) return res.status(404).json({ error: "Ticket not found" });
  res.json({ ticket });
});

const updateSchema = z.object({
  status: z.enum(["OPEN", "IN_PROGRESS", "CLOSED"]).optional(),
  assigneeId: z.string().nullable().optional(),
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

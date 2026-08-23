// Turns NormalizedEmail objects from a MailProvider into Ticket/Message rows.
// Idempotent: re-ingesting the same providerMessageId is a no-op (enforced
// by the DB unique constraint, not just application logic).

import sanitizeHtml from "sanitize-html";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client";
import { tickets, messages, attachments, emailAccounts } from "../db/schema";
import type { NormalizedEmail } from "./provider.interface";
import { resolveParentMessageId } from "./threading";
import { CLOSED_STATUSES } from "../types";

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img"]),
  allowedAttributes: {
    ...sanitizeHtml.defaults.allowedAttributes,
    img: ["src", "alt", "width", "height"],
    "*": ["style"],
  },
  allowedSchemes: ["http", "https", "mailto", "data"],
};

function sanitizeBody(html: string | undefined, text: string): string {
  if (html) return sanitizeHtml(html, SANITIZE_OPTIONS);
  // Plain-text fallback: escape and preserve line breaks.
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<pre style="white-space:pre-wrap;font-family:inherit">${escaped}</pre>`;
}

async function findExistingTicketId(emailAccountId: string, email: NormalizedEmail): Promise<string | undefined> {
  // Primary path: match on the provider's own thread id.
  const [byThread] = await db
    .select({ id: tickets.id })
    .from(tickets)
    .where(and(eq(tickets.emailAccountId, emailAccountId), eq(tickets.providerThreadId, email.providerThreadId)))
    .limit(1);
  if (byThread) return byThread.id;

  // Fallback: does this email's References/In-Reply-To chain point at a
  // message we already have, but under a different provider thread id?
  const parentId = resolveParentMessageId(email);
  if (!parentId) return undefined;
  const [byParent] = await db
    .select({ ticketId: messages.ticketId })
    .from(messages)
    .where(eq(messages.messageIdHeader, parentId))
    .limit(1);
  return byParent?.ticketId;
}

function extractName(fromHeader: string): { email: string; name?: string } {
  const match = fromHeader.match(/^(.*?)<(.+?)>$/);
  if (match) {
    const name = match[1].trim().replace(/^"|"$/g, "");
    return { email: match[2].trim(), name: name || undefined };
  }
  return { email: fromHeader.trim() };
}

/**
 * Ingest a single inbound email. Returns the ticket it landed on, and whether
 * this was genuinely new mail (`created: false` means we had already stored
 * this message — re-polling is a no-op).
 */
export async function ingestEmail(
  emailAccountId: string,
  email: NormalizedEmail
): Promise<{ ticketId: string; created: boolean; newTicketId: string | null }> {
  return db.transaction(async (tx) => {
    // Idempotency guard: if we've already stored this providerMessageId,
    // there's nothing to do (covers re-polling after a crash).
    const [already] = await tx
      .select({ ticketId: messages.ticketId })
      .from(messages)
      .where(eq(messages.providerMessageId, email.providerMessageId))
      .limit(1);
    if (already) return { ticketId: already.ticketId, created: false, newTicketId: null };

    let ticketId = await findExistingTicketId(emailAccountId, email);
    let newTicketId: string | null = null;

    if (!ticketId) {
      const { email: requesterEmail, name: requesterName } = extractName(email.from);
      // Newsletters and other machine-generated mail still become a ticket so
      // nothing is silently lost and it stays searchable — but it is created
      // already closed and flagged isBulk, which keeps it out of the Active
      // list and out of every SLA / Dashboard / Reports number.
      const [newTicket] = await tx
        .insert(tickets)
        .values({
          subject: email.subject,
          requesterEmail,
          requesterName,
          providerThreadId: email.providerThreadId,
          emailAccountId,
          status: email.isAutoReply ? "UNRESOLVED_CLOSED" : "OPEN",
          isBulk: email.isAutoReply,
        })
        .returning({ id: tickets.id });
      ticketId = newTicket.id;
      // Only genuine new conversations are worth triaging; bulk mail is
      // already filed away closed.
      if (!email.isAutoReply) newTicketId = ticketId;
    } else if (!email.isAutoReply) {
      // A genuine (non-auto) reply on an existing thread reopens it if it
      // had been closed, rather than forking a new ticket. It also clears the
      // bulk flag: a human has written in, so this is a real conversation now
      // (and it recovers gracefully if detection ever misfires).
      const [ticket] = await tx.select({ status: tickets.status }).from(tickets).where(eq(tickets.id, ticketId)).limit(1);
      if (ticket && CLOSED_STATUSES.includes(ticket.status)) {
        await tx.update(tickets).set({ status: "OPEN", isBulk: false, updatedAt: new Date() }).where(eq(tickets.id, ticketId));
      } else {
        await tx.update(tickets).set({ isBulk: false, updatedAt: new Date() }).where(eq(tickets.id, ticketId));
      }
    }

    const [message] = await tx
      .insert(messages)
      .values({
        ticketId,
        direction: "INBOUND",
        fromAddress: email.from,
        toAddresses: email.to,
        ccAddresses: email.cc,
        subject: email.subject,
        bodyHtml: sanitizeBody(email.bodyHtml, email.bodyText),
        bodyText: email.bodyText,
        providerMessageId: email.providerMessageId,
        providerThreadId: email.providerThreadId,
        messageIdHeader: email.messageIdHeader,
        inReplyToHeader: email.inReplyToHeader,
        referencesHeader: email.referencesHeader,
        isAutoReply: email.isAutoReply,
        bulkSignals: email.bulkSignals,
        sentAt: email.receivedAt,
      })
      .returning({ id: messages.id });

    if (email.attachments.length > 0) {
      await tx.insert(attachments).values(
        email.attachments.map((a) => ({
          messageId: message.id,
          providerAttachmentId: a.providerAttachmentId,
          filename: a.filename,
          mimeType: a.mimeType,
          size: a.size,
        }))
      );
    }

    return { ticketId, created: true, newTicketId };
  });
}

export async function markAccountError(emailAccountId: string, errorMessage: string) {
  await db
    .update(emailAccounts)
    .set({ status: "error", lastError: errorMessage, updatedAt: new Date() })
    .where(eq(emailAccounts.id, emailAccountId));
}

export async function clearAccountError(emailAccountId: string) {
  await db
    .update(emailAccounts)
    .set({ status: "connected", lastError: null, updatedAt: new Date() })
    .where(eq(emailAccounts.id, emailAccountId));
}

import { desc, eq } from "drizzle-orm";
import { db } from "../db/client";
import { messages, tickets, users } from "../db/schema";
import { decryptToken } from "../crypto/token-encryption";
import { getProvider } from "../mail/registry";
import { getEmailAccountForTicket } from "./ticket.service";

export class ReplyError extends Error {}

/**
 * Sends a reply from a team member back to the customer through the
 * ticket's connected mailbox, threaded onto the original conversation, and
 * records it as an outbound Message.
 */
export async function sendTicketReply(params: {
  ticketId: string;
  authorId: string;
  bodyHtml: string;
  ccOverride?: string[];
}) {
  const found = await getEmailAccountForTicket(params.ticketId);
  if (!found) throw new ReplyError("Ticket not found");
  const { ticket, emailAccount } = found;

  if (!emailAccount || emailAccount.status !== "connected") {
    throw new ReplyError(
      "This ticket's mailbox is disconnected. Reconnect it from Settings before replying."
    );
  }

  // Thread onto the most recent inbound message so In-Reply-To/References
  // point at what the customer actually sent, not our own prior replies.
  const [lastInbound] = await db
    .select()
    .from(messages)
    .where(eq(messages.ticketId, params.ticketId))
    .orderBy(desc(messages.sentAt))
    .limit(20)
    .then((rows) => rows.filter((m) => m.direction === "INBOUND"));

  const [author] = await db.select().from(users).where(eq(users.id, params.authorId)).limit(1);
  if (!author) throw new ReplyError("Author not found");

  // Replies are attributed to (and signed as) the ticket's current assignee,
  // falling back to whoever actually sent them if the ticket is unassigned.
  const [assignee] = ticket.assigneeId
    ? await db.select().from(users).where(eq(users.id, ticket.assigneeId)).limit(1)
    : [];
  const attributedTo = assignee ?? author;

  const signedBody = `${params.bodyHtml}<br/><br/><span style="color:#888">— ${attributedTo.name}</span>`;

  // Manual (e.g. phone) tickets have a synthetic thread id until the first
  // email goes out; sending without a threadId starts a fresh email thread.
  const isManualThread = ticket.providerThreadId.startsWith("manual-");
  const hasEmailInbound = lastInbound && !lastInbound.providerMessageId.startsWith("manual-");

  const to = hasEmailInbound ? [lastInbound.fromAddress] : ticket.requesterEmail ? [ticket.requesterEmail] : [];
  if (to.length === 0) {
    throw new ReplyError("This ticket has no email address to reply to. Add one or use an internal note.");
  }
  const cc = params.ccOverride ?? (hasEmailInbound ? (lastInbound.ccAddresses as string[]) : []);

  const provider = getProvider(emailAccount.provider);
  const refreshToken = decryptToken({
    ciphertext: emailAccount.encryptedRefreshToken,
    iv: emailAccount.tokenIv,
    authTag: emailAccount.tokenAuthTag,
  });

  const result = await provider.sendReply(refreshToken, {
    threadId: isManualThread ? undefined : ticket.providerThreadId,
    inReplyToMessageIdHeader: hasEmailInbound ? lastInbound.messageIdHeader ?? undefined : undefined,
    referencesHeader: hasEmailInbound ? lastInbound.referencesHeader ?? undefined : undefined,
    to,
    cc,
    subject: ticket.subject.startsWith("Re:") ? ticket.subject : `Re: ${ticket.subject}`,
    bodyHtml: signedBody,
  });

  const [message] = await db
    .insert(messages)
    .values({
      ticketId: params.ticketId,
      direction: "OUTBOUND",
      authorId: attributedTo.id,
      fromAddress: emailAccount.email,
      toAddresses: to,
      ccAddresses: cc,
      subject: ticket.subject,
      bodyHtml: signedBody,
      providerMessageId: result.providerMessageId,
      providerThreadId: result.providerThreadId,
      messageIdHeader: result.messageIdHeader,
      sentAt: result.sentAt,
    })
    .returning();

  // A reply is the agent taking action on the ticket; auto-advance OPEN -> IN_PROGRESS.
  // For manual tickets, adopt the real email thread id so future replies (and
  // the customer's responses) thread onto this conversation.
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (ticket.status === "OPEN") updates.status = "IN_PROGRESS";
  if (isManualThread && result.providerThreadId) updates.providerThreadId = result.providerThreadId;
  await db.update(tickets).set(updates).where(eq(tickets.id, ticket.id));

  return message;
}

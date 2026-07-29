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

  const signedBody = `${params.bodyHtml}<br/><br/><span style="color:#888">— ${author.name}</span>`;

  const to = lastInbound ? [lastInbound.fromAddress] : [ticket.requesterEmail];
  const cc = params.ccOverride ?? (lastInbound ? (lastInbound.ccAddresses as string[]) : []);

  const provider = getProvider(emailAccount.provider);
  const refreshToken = decryptToken({
    ciphertext: emailAccount.encryptedRefreshToken,
    iv: emailAccount.tokenIv,
    authTag: emailAccount.tokenAuthTag,
  });

  const result = await provider.sendReply(refreshToken, {
    threadId: ticket.providerThreadId,
    inReplyToMessageIdHeader: lastInbound?.messageIdHeader ?? undefined,
    referencesHeader: lastInbound?.referencesHeader ?? undefined,
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
      authorId: params.authorId,
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
  if (ticket.status === "OPEN") {
    await db.update(tickets).set({ status: "IN_PROGRESS", updatedAt: new Date() }).where(eq(tickets.id, ticket.id));
  } else {
    await db.update(tickets).set({ updatedAt: new Date() }).where(eq(tickets.id, ticket.id));
  }

  return message;
}

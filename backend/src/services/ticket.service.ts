import { and, desc, eq, or, sql } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import { db } from "../db/client";
import { tickets, messages, notes, users, emailAccounts } from "../db/schema";
import type { TicketStatus, TicketQueue, TicketChannel } from "../types";

export interface TicketListFilters {
  status?: TicketStatus;
  assigneeId?: string | null; // null = explicitly unassigned
}

/**
 * Per-ticket message timing: when the first customer message arrived and when
 * the team's first reply went out. One grouped query for all tickets.
 */
async function messageTimings() {
  const rows = await db
    .select({
      ticketId: messages.ticketId,
      firstInboundAt: sql<string | null>`min(${messages.sentAt}) filter (where ${messages.direction} = 'INBOUND')`,
      firstReplyAt: sql<string | null>`min(${messages.sentAt}) filter (where ${messages.direction} = 'OUTBOUND')`,
    })
    .from(messages)
    .groupBy(messages.ticketId);
  return new Map(rows.map((r) => [r.ticketId, r]));
}

export async function listTickets(filters: TicketListFilters) {
  const conditions = [];
  if (filters.status) conditions.push(eq(tickets.status, filters.status));
  if (filters.assigneeId === null) conditions.push(sql`${tickets.assigneeId} is null`);
  else if (filters.assigneeId) conditions.push(eq(tickets.assigneeId, filters.assigneeId));

  const [rows, timings] = await Promise.all([
    db.query.tickets.findMany({
      where: conditions.length ? and(...conditions) : undefined,
      orderBy: desc(tickets.updatedAt),
      with: {
        assignee: true,
        emailAccount: { columns: { email: true, provider: true } },
        messages: { orderBy: desc(messages.sentAt), limit: 1 },
      },
    }),
    messageTimings(),
  ]);

  return rows.map((t) => {
    const timing = timings.get(t.id);
    return {
      id: t.id,
      ticketNumber: t.ticketNumber,
      subject: t.subject,
      requesterEmail: t.requesterEmail,
      requesterName: t.requesterName,
      requesterPhone: t.requesterPhone,
      status: t.status,
      queue: t.queue,
      channel: t.channel,
      isBulk: t.isBulk,
      assignee: t.assignee ? { id: t.assignee.id, name: t.assignee.name, email: t.assignee.email } : null,
      mailbox: t.emailAccount.email,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      receivedAt: timing?.firstInboundAt ?? t.createdAt,
      firstReplyAt: timing?.firstReplyAt ?? null,
      lastMessagePreview: t.messages[0]
        ? {
            direction: t.messages[0].direction,
            snippet: t.messages[0].bodyText?.slice(0, 140) ?? "",
            sentAt: t.messages[0].sentAt,
          }
        : null,
    };
  });
}

/**
 * Create a ticket by hand (e.g. for a phone call) instead of from an email.
 * The description is stored as the ticket's first inbound message.
 */
export async function createManualTicket(params: {
  subject: string;
  body?: string;
  requesterName?: string;
  requesterEmail?: string;
  requesterPhone?: string;
  channel: TicketChannel;
  queue?: TicketQueue | null;
  assigneeId?: string | null;
  status?: TicketStatus;
}) {
  const [account] = await db.select().from(emailAccounts).limit(1);
  if (!account) {
    throw new Error("Connect a mailbox in Settings before creating tickets.");
  }

  const threadId = `manual-${createId()}`;
  const [ticket] = await db
    .insert(tickets)
    .values({
      subject: params.subject,
      requesterEmail: params.requesterEmail ?? null,
      requesterName: params.requesterName ?? null,
      requesterPhone: params.requesterPhone ?? null,
      status: params.status ?? "OPEN",
      queue: params.queue ?? null,
      channel: params.channel,
      providerThreadId: threadId,
      emailAccountId: account.id,
      assigneeId: params.assigneeId ?? null,
    })
    .returning();

  if (params.body?.trim()) {
    const from =
      params.requesterEmail ??
      params.requesterPhone ??
      params.requesterName ??
      "Manual entry";
    const escaped = params.body
      .split("\n")
      .map((line) => `<p>${line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") || "&nbsp;"}</p>`)
      .join("");
    await db.insert(messages).values({
      ticketId: ticket.id,
      direction: "INBOUND",
      fromAddress: from,
      toAddresses: [account.email],
      ccAddresses: [],
      subject: params.subject,
      bodyHtml: escaped,
      bodyText: params.body,
      providerMessageId: `manual-${createId()}`,
      providerThreadId: threadId,
      sentAt: new Date(),
    });
  }

  return ticket;
}

export async function getTicketDetail(ticketId: string) {
  const ticket = await db.query.tickets.findFirst({
    where: eq(tickets.id, ticketId),
    with: {
      assignee: true,
      emailAccount: { columns: { id: true, email: true, provider: true } },
      messages: {
        orderBy: messages.sentAt,
        with: { author: true, attachments: true },
      },
      notes: {
        orderBy: notes.createdAt,
        with: { author: true },
      },
    },
  });
  return ticket ?? null;
}

/**
 * Other tickets from the same requester (matched by email, case-insensitive,
 * or by exact display name) — newest first, excluding the ticket itself.
 */
export async function listRequesterHistory(ticketId: string) {
  const [current] = await db.select().from(tickets).where(eq(tickets.id, ticketId)).limit(1);
  if (!current) return null;

  const emailMatch = current.requesterEmail
    ? sql`lower(${tickets.requesterEmail}) = lower(${current.requesterEmail})`
    : sql`false`;
  const nameMatch = current.requesterName
    ? eq(tickets.requesterName, current.requesterName)
    : sql`false`;

  const rows = await db.query.tickets.findMany({
    where: and(sql`${tickets.id} <> ${ticketId}`, or(emailMatch, nameMatch)),
    orderBy: desc(tickets.updatedAt),
    limit: 50,
    with: { messages: { orderBy: desc(messages.sentAt), limit: 1 } },
  });

  return rows.map((t) => ({
    id: t.id,
    ticketNumber: t.ticketNumber,
    subject: t.subject,
    status: t.status,
    requesterEmail: t.requesterEmail,
    requesterName: t.requesterName,
    updatedAt: t.updatedAt,
    snippet: t.messages[0]?.bodyText?.slice(0, 120) ?? "",
  }));
}

export async function updateTicket(
  ticketId: string,
  updates: {
    status?: TicketStatus;
    assigneeId?: string | null;
    queue?: TicketQueue | null;
    channel?: TicketChannel;
  }
) {
  const [updated] = await db
    .update(tickets)
    .set({ ...updates, updatedAt: new Date() })
    .where(eq(tickets.id, ticketId))
    .returning();
  return updated ?? null;
}

export async function assertUserExists(userId: string) {
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
  return Boolean(user);
}

export async function getEmailAccountForTicket(ticketId: string) {
  const ticket = await db.query.tickets.findFirst({
    where: eq(tickets.id, ticketId),
    with: { emailAccount: true },
  });
  return ticket
    ? { ticket, emailAccount: ticket.emailAccount }
    : null;
}

export async function listEmailAccountRow(id: string) {
  const [row] = await db.select().from(emailAccounts).where(eq(emailAccounts.id, id)).limit(1);
  return row ?? null;
}

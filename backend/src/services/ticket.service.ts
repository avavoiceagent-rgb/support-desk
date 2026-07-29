import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db/client";
import { tickets, messages, notes, users, emailAccounts } from "../db/schema";
import type { TicketStatus } from "../types";

export interface TicketListFilters {
  status?: TicketStatus;
  assigneeId?: string | null; // null = explicitly unassigned
}

export async function listTickets(filters: TicketListFilters) {
  const conditions = [];
  if (filters.status) conditions.push(eq(tickets.status, filters.status));
  if (filters.assigneeId === null) conditions.push(sql`${tickets.assigneeId} is null`);
  else if (filters.assigneeId) conditions.push(eq(tickets.assigneeId, filters.assigneeId));

  const rows = await db.query.tickets.findMany({
    where: conditions.length ? and(...conditions) : undefined,
    orderBy: desc(tickets.updatedAt),
    with: {
      assignee: true,
      emailAccount: { columns: { email: true, provider: true } },
      messages: { orderBy: desc(messages.sentAt), limit: 1 },
    },
  });

  return rows.map((t) => ({
    id: t.id,
    ticketNumber: t.ticketNumber,
    subject: t.subject,
    requesterEmail: t.requesterEmail,
    requesterName: t.requesterName,
    status: t.status,
    assignee: t.assignee ? { id: t.assignee.id, name: t.assignee.name, email: t.assignee.email } : null,
    mailbox: t.emailAccount.email,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    lastMessagePreview: t.messages[0]
      ? {
          direction: t.messages[0].direction,
          snippet: t.messages[0].bodyText?.slice(0, 140) ?? "",
          sentAt: t.messages[0].sentAt,
        }
      : null,
  }));
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

export async function updateTicket(
  ticketId: string,
  updates: { status?: TicketStatus; assigneeId?: string | null }
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

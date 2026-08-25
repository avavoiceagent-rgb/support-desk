import { and, asc, desc, eq, or, sql } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import { db } from "../db/client";
import { tickets, messages, notes, users, emailAccounts } from "../db/schema";
import { reservationForTicket } from "../ops/reservations";
import { listDispatchForTrip } from "../ops/dispatch";
import { listTripEvents } from "../ops/trip-events";
import { extractReferences } from "../ops/references";
import { findTripByReference, theirBooking } from "../ops/lookup";
import { toPlainText } from "../ai/classifier";
import type { TicketStatus, TicketQueue, TicketChannel, ReservationType, ReservationSource } from "../types";

export interface TicketListFilters {
  status?: TicketStatus;
  assigneeId?: string | null; // null = explicitly unassigned
}

/**
 * Postgres hands back a `timestamp without time zone` from a raw aggregate as
 * a NAIVE STRING ("2026-08-19 23:07:44.448"), not a Date — unlike the same
 * column read through Drizzle, which arrives as a Date and serialises with a
 * trailing Z. Shipped to the browser untouched, that naive string is parsed as
 * the VIEWER's local time, so every Received time and every "still waiting"
 * SLA figure was wrong by the viewer's UTC offset (two hours in Berlin).
 *
 * The column stores UTC, so say so explicitly before the value leaves here.
 */
export function toIsoUtc(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value);
  const parsed = new Date(hasZone ? value : `${value.replace(" ", "T")}Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
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
      reservationType: t.reservationType,
      reservationSource: t.reservationSource,
      autoClassified: t.autoClassified,
      classificationReason: t.classificationReason,
      classificationConfidence: t.classificationConfidence,
      isBulk: t.isBulk,
      assignee: t.assignee ? { id: t.assignee.id, name: t.assignee.name, email: t.assignee.email } : null,
      mailbox: t.emailAccount.email,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      receivedAt: toIsoUtc(timing?.firstInboundAt) ?? t.createdAt,
      firstReplyAt: toIsoUtc(timing?.firstReplyAt),
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

/**
 * A ticket with everything the timeline shows, dispatch traffic included.
 *
 * The dispatch messages are fetched separately because they hang off the
 * reservation rather than the ticket — there is no relation from one to the
 * other, and inventing one would duplicate a fact the trip already holds.
 */
/**
 * The bookings a ticket is about.
 *
 * Not just its own reservation. A change request arrives as a new ticket that
 * quotes a booking made from an older one — which is exactly what happened
 * here: the pickup on T-10308 was moved from the change ticket, and the
 * record of it landed on the ticket that first created the trip. The ticket
 * where the work was done showed nothing at all.
 *
 * Quoted references only, never the sender's other bookings: "they named this
 * booking" is evidence that the ticket is about it, and "this is their next
 * trip" is a guess that would drag unrelated history into the timeline.
 */
export async function tripsThisTicketIsAbout(ticketId: string): Promise<string[]> {
  const own = await reservationForTicket(ticketId);

  // The first inbound message is what the customer wrote; later ones may
  // quote our own replies back at us, references and all.
  const [firstInbound] = await db
    .select({
      subject: messages.subject,
      bodyHtml: messages.bodyHtml,
      bodyText: messages.bodyText,
    })
    .from(messages)
    .where(and(eq(messages.ticketId, ticketId), eq(messages.direction, "INBOUND")))
    .orderBy(asc(messages.sentAt))
    .limit(1);

  const references = firstInbound
    ? extractReferences(
        firstInbound.subject,
        toPlainText(firstInbound.bodyHtml, firstInbound.bodyText)
      ).trips
    : [];

  // Only the sender's own bookings. A reference proves the trip exists, not
  // that it is theirs — see `theirBooking`. Without this a customer forwarding
  // an airline confirmation whose number happened to land in our range got
  // somebody else's dispatch thread attached to their ticket.
  const [ticketRow] = await db
    .select({ requesterEmail: tickets.requesterEmail })
    .from(tickets)
    .where(eq(tickets.id, ticketId))
    .limit(1);
  const asker = ticketRow?.requesterEmail ?? null;

  const found = await Promise.all(references.map((ref) => findTripByReference(ref)));
  const theirs = await Promise.all(found.map((t) => theirBooking(t, asker)));
  const quoted = found.filter((_, i) => theirs[i]);

  const ids: string[] = [];
  for (const id of [own?.id, ...quoted.map((t) => t?.id)]) {
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
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
  if (!ticket) return null;

  const tripIds = await tripsThisTicketIsAbout(ticketId);
  // Both hang off the booking: what was said to the driver, and what was done
  // to the trip. A ticket that shows the request but not the change made in
  // answer to it is half a record.
  const [dispatch, tripEvents] = await Promise.all([
    Promise.all(tripIds.map(listDispatchForTrip)).then((lists) =>
      lists.flat().sort((a, b) => a.at.getTime() - b.at.getTime())
    ),
    Promise.all(tripIds.map(listTripEvents)).then((lists) =>
      lists.flat().sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    ),
  ]);
  return { ...ticket, dispatch, tripEvents };
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
    reservationType?: ReservationType | null;
    reservationSource?: ReservationSource | null;
  }
) {
  // Once a person edits any triage field the ticket stops being "set
  // automatically" — the badge disappears and nothing will re-label it.
  const touchesTriage =
    "queue" in updates || "reservationType" in updates || "reservationSource" in updates;

  // Reservation sub-labels only mean something on a reservation ticket.
  // Clearing them here rather than in the UI means it happens no matter which
  // screen sent the edit, and no stale label can reappear if the ticket is
  // later moved back into Reservation.
  const leavingReservation = "queue" in updates && updates.queue !== "RESERVATION";

  const [updated] = await db
    .update(tickets)
    .set({
      ...updates,
      ...(leavingReservation
        ? { reservationType: null, reservationSource: null }
        : {}),
      ...(touchesTriage ? { autoClassified: false, classificationReason: null, classificationConfidence: null } : {}),
      updatedAt: new Date(),
    })
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

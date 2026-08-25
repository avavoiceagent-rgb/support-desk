import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "../db/client";
import { tickets, messages, notes, users } from "../db/schema";
import { CLOSED_STATUSES } from "../types";

const SLA_TARGET_MS = 24 * 60 * 60 * 1000;
const closed = new Set<string>(CLOSED_STATUSES);

function avg(nums: number[]): number | null {
  if (!nums.length) return null;
  return Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);
}

/**
 * Analytical reports over a date range (days=0 means all time).
 * Everything is computed from tickets CREATED in the range, plus reply/note
 * activity that happened in the range. Bulk tickets (newsletters, marketing,
 * auto-replies) are excluded throughout — they are not real support work and
 * would otherwise register as permanent SLA breaches.
 */
export async function getReports(days: number) {
  const since = days > 0 ? new Date(Date.now() - days * 86_400_000) : null;

  const [rangeTickets, timingRows, rangeMessages, rangeNotes, allUsers] = await Promise.all([
    since
      ? db.query.tickets.findMany({ where: and(gte(tickets.createdAt, since), eq(tickets.isBulk, false)) })
      : db.query.tickets.findMany({ where: eq(tickets.isBulk, false) }),
    db
      .select({
        ticketId: messages.ticketId,
        firstInboundAt: sql<string | null>`min(${messages.sentAt}) filter (where ${messages.direction} = 'INBOUND')`,
        firstReplyAt: sql<string | null>`min(${messages.sentAt}) filter (where ${messages.direction} = 'OUTBOUND')`,
      })
      .from(messages)
      .groupBy(messages.ticketId),
    since
      ? db
          .select({ authorId: messages.authorId, direction: messages.direction, sentAt: messages.sentAt })
          .from(messages)
          .where(gte(messages.sentAt, since))
      : db.select({ authorId: messages.authorId, direction: messages.direction, sentAt: messages.sentAt }).from(messages),
    since
      ? db.select({ authorId: notes.authorId }).from(notes).where(gte(notes.createdAt, since))
      : db.select({ authorId: notes.authorId }).from(notes),
    db.select({ id: users.id, name: users.name }).from(users),
  ]);

  const timings = new Map(timingRows.map((r) => [r.ticketId, r]));
  const now = Date.now();

  const receivedOf = (t: (typeof rangeTickets)[number]) => {
    const timing = timings.get(t.id);
    return timing?.firstInboundAt ? new Date(timing.firstInboundAt).getTime() : t.createdAt.getTime();
  };
  const firstReplyOf = (t: (typeof rangeTickets)[number]) => {
    const timing = timings.get(t.id);
    return timing?.firstReplyAt ? new Date(timing.firstReplyAt).getTime() : null;
  };

  // ---------- KPIs & ticket-wise ----------
  const byStatus: Record<string, number> = {};
  const byQueue: Record<string, number> = {};
  const byChannel: Record<string, number> = {};
  let resolvedCount = 0;
  let slaBreaches = 0;
  const firstReplyDurations: number[] = [];
  const resolutionDurations: number[] = [];

  for (const t of rangeTickets) {
    byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
    byQueue[t.queue ?? "NONE"] = (byQueue[t.queue ?? "NONE"] ?? 0) + 1;
    byChannel[t.channel] = (byChannel[t.channel] ?? 0) + 1;

    const received = receivedOf(t);
    const reply = firstReplyOf(t);
    if (reply !== null && reply >= received) {
      firstReplyDurations.push(reply - received);
      if (reply - received > SLA_TARGET_MS) slaBreaches++;
    } else if (!closed.has(t.status) && now - received > SLA_TARGET_MS) {
      slaBreaches++;
    }

    if (closed.has(t.status)) {
      resolvedCount++;
      // Approximation: closing is normally the last update on a ticket.
      const ms = t.updatedAt.getTime() - received;
      if (ms >= 0) resolutionDurations.push(ms);
    }
  }

  // Created vs resolved trend. Daily buckets for ranges; monthly for all time.
  const monthly = days === 0 || days > 92;
  const bucketOf = (d: Date) => (monthly ? d.toISOString().slice(0, 7) : d.toISOString().slice(0, 10));
  const buckets: string[] = [];
  if (monthly) {
    const first = rangeTickets.length
      ? rangeTickets.reduce((min, t) => (t.createdAt < min ? t.createdAt : min), new Date())
      : new Date();
    const cur = new Date(first.getFullYear(), first.getMonth(), 1);
    const end = new Date();
    while (cur <= end) {
      buckets.push(cur.toISOString().slice(0, 7));
      cur.setMonth(cur.getMonth() + 1);
    }
  } else {
    for (let i = days - 1; i >= 0; i--) {
      buckets.push(new Date(now - i * 86_400_000).toISOString().slice(0, 10));
    }
  }
  const createdPer: Record<string, number> = Object.fromEntries(buckets.map((b) => [b, 0]));
  const resolvedPer: Record<string, number> = Object.fromEntries(buckets.map((b) => [b, 0]));
  for (const t of rangeTickets) {
    const cb = bucketOf(t.createdAt);
    if (cb in createdPer) createdPer[cb]++;
    if (closed.has(t.status)) {
      const rb = bucketOf(t.updatedAt);
      if (rb in resolvedPer) resolvedPer[rb]++;
    }
  }

  // Oldest tickets still waiting on us.
  const oldestOpen = rangeTickets
    .filter((t) => !closed.has(t.status))
    .sort((a, b) => receivedOf(a) - receivedOf(b))
    .slice(0, 5)
    .map((t) => ({
      id: t.id,
      ticketNumber: t.ticketNumber,
      subject: t.subject,
      status: t.status,
      ageMs: now - receivedOf(t),
      assigneeId: t.assigneeId,
    }));

  // ---------- Team-member-wise ----------
  const repliesByAuthor = new Map<string, number>();
  for (const m of rangeMessages) {
    if (m.direction === "OUTBOUND" && m.authorId) {
      repliesByAuthor.set(m.authorId, (repliesByAuthor.get(m.authorId) ?? 0) + 1);
    }
  }
  const notesByAuthor = new Map<string, number>();
  for (const n of rangeNotes) {
    // Desk notes have no author. They are Adam's, and counting them towards
    // whoever happened to be on the ticket would flatter somebody's numbers.
    if (!n.authorId) continue;
    notesByAuthor.set(n.authorId, (notesByAuthor.get(n.authorId) ?? 0) + 1);
  }

  const agents = allUsers.map((u) => {
    const mine = rangeTickets.filter((t) => t.assigneeId === u.id);
    const replyTimes: number[] = [];
    let met = 0;
    let replied = 0;
    const resolution: number[] = [];
    for (const t of mine) {
      const received = receivedOf(t);
      const reply = firstReplyOf(t);
      if (reply !== null && reply >= received) {
        replied++;
        replyTimes.push(reply - received);
        if (reply - received <= SLA_TARGET_MS) met++;
      }
      if (closed.has(t.status)) {
        const ms = t.updatedAt.getTime() - received;
        if (ms >= 0) resolution.push(ms);
      }
    }
    return {
      id: u.id,
      name: u.name,
      assigned: mine.length,
      open: mine.filter((t) => !closed.has(t.status)).length,
      closed: mine.filter((t) => closed.has(t.status)).length,
      repliesSent: repliesByAuthor.get(u.id) ?? 0,
      notesAdded: notesByAuthor.get(u.id) ?? 0,
      avgFirstReplyMs: avg(replyTimes),
      slaMetPct: replied ? Math.round((met / replied) * 100) : null,
      avgResolutionMs: avg(resolution),
    };
  });
  const unassignedCount = rangeTickets.filter((t) => !t.assigneeId && !closed.has(t.status)).length;

  // ---------- Customer-wise ----------
  const byCustomer = new Map<
    string,
    { label: string; email: string | null; count: number; open: number; closedCount: number; lastContact: number; replyTimes: number[] }
  >();
  for (const t of rangeTickets) {
    const key = t.requesterEmail?.toLowerCase() ?? t.requesterName ?? t.requesterPhone ?? "unknown";
    const entry =
      byCustomer.get(key) ?? {
        label: t.requesterName ?? t.requesterEmail ?? t.requesterPhone ?? "Unknown",
        email: t.requesterEmail,
        count: 0,
        open: 0,
        closedCount: 0,
        lastContact: 0,
        replyTimes: [],
      };
    entry.count++;
    if (closed.has(t.status)) entry.closedCount++;
    else entry.open++;
    entry.lastContact = Math.max(entry.lastContact, t.updatedAt.getTime());
    const reply = firstReplyOf(t);
    const received = receivedOf(t);
    if (reply !== null && reply >= received) entry.replyTimes.push(reply - received);
    byCustomer.set(key, entry);
  }
  const customers = [...byCustomer.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 15)
    .map((c) => ({
      label: c.label,
      email: c.email,
      tickets: c.count,
      open: c.open,
      closed: c.closedCount,
      lastContact: new Date(c.lastContact).toISOString(),
      avgFirstReplyMs: avg(c.replyTimes),
    }));

  return {
    rangeDays: days,
    totals: {
      created: rangeTickets.length,
      resolved: resolvedCount,
      openNow: rangeTickets.length - resolvedCount,
      unassignedOpen: unassignedCount,
      slaBreaches,
      avgFirstReplyMs: avg(firstReplyDurations),
      avgResolutionMs: avg(resolutionDurations),
      repeatCustomerPct: byCustomer.size
        ? Math.round(([...byCustomer.values()].filter((c) => c.count > 1).length / byCustomer.size) * 100)
        : null,
    },
    trend: buckets.map((b) => ({ bucket: b, created: createdPer[b], resolved: resolvedPer[b] })),
    byStatus,
    byQueue,
    byChannel,
    oldestOpen,
    agents,
    customers,
  };
}

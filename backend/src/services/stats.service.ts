import { desc, eq, sql } from "drizzle-orm";
import { db } from "../db/client";
import { tickets, messages, users } from "../db/schema";
import { CLOSED_STATUSES } from "../types";

const SLA_TARGET_MS = 24 * 60 * 60 * 1000;

/**
 * Aggregated numbers for the dashboard. Bulk tickets (newsletters, marketing,
 * auto-replies) are excluded so they cannot skew SLA or volume figures.
 */
export async function getStats() {
  const [allTickets, timingRows, allUsers] = await Promise.all([
    db.query.tickets.findMany({ where: eq(tickets.isBulk, false), orderBy: desc(tickets.createdAt) }),
    db
      .select({
        ticketId: messages.ticketId,
        firstInboundAt: sql<string | null>`min(${messages.sentAt}) filter (where ${messages.direction} = 'INBOUND')`,
        firstReplyAt: sql<string | null>`min(${messages.sentAt}) filter (where ${messages.direction} = 'OUTBOUND')`,
      })
      .from(messages)
      .groupBy(messages.ticketId),
    db.select({ id: users.id, name: users.name }).from(users),
  ]);

  const timings = new Map(timingRows.map((r) => [r.ticketId, r]));
  const now = Date.now();
  const closed = new Set<string>(CLOSED_STATUSES);

  const byStatus: Record<string, number> = {};
  const byQueue: Record<string, number> = {};
  const byChannel: Record<string, number> = {};
  const byAgent = new Map<string | null, { open: number; closed: number }>();

  let repliedCount = 0;
  let repliedWithinTarget = 0;
  let totalFirstReplyMs = 0;
  let awaitingReply = 0;
  let awaitingOverdue = 0;

  // Ticket volume per day, last 14 days (local server time).
  const dayKeys: string[] = [];
  const perDay: Record<string, number> = {};
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now - i * 86_400_000);
    const key = d.toISOString().slice(0, 10);
    dayKeys.push(key);
    perDay[key] = 0;
  }

  for (const t of allTickets) {
    byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
    byQueue[t.queue ?? "NONE"] = (byQueue[t.queue ?? "NONE"] ?? 0) + 1;
    byChannel[t.channel] = (byChannel[t.channel] ?? 0) + 1;

    const agentKey = t.assigneeId ?? null;
    const agent = byAgent.get(agentKey) ?? { open: 0, closed: 0 };
    if (closed.has(t.status)) agent.closed++;
    else agent.open++;
    byAgent.set(agentKey, agent);

    const timing = timings.get(t.id);
    const receivedAt = timing?.firstInboundAt ? new Date(timing.firstInboundAt).getTime() : t.createdAt.getTime();
    if (timing?.firstReplyAt) {
      const ms = new Date(timing.firstReplyAt).getTime() - receivedAt;
      if (ms >= 0) {
        repliedCount++;
        totalFirstReplyMs += ms;
        if (ms <= SLA_TARGET_MS) repliedWithinTarget++;
      }
    } else if (!closed.has(t.status)) {
      awaitingReply++;
      if (now - receivedAt > SLA_TARGET_MS) awaitingOverdue++;
    }

    const dayKey = t.createdAt.toISOString().slice(0, 10);
    if (dayKey in perDay) perDay[dayKey]++;
  }

  const userNames = new Map(allUsers.map((u) => [u.id, u.name]));
  const agents = [...byAgent.entries()]
    .map(([id, counts]) => ({
      id,
      name: id ? userNames.get(id) ?? "Unknown" : "Unassigned",
      open: counts.open,
      closed: counts.closed,
      total: counts.open + counts.closed,
    }))
    .sort((a, b) => b.total - a.total);

  return {
    totalTickets: allTickets.length,
    byStatus,
    byQueue,
    byChannel,
    agents,
    sla: {
      targetHours: 24,
      repliedCount,
      repliedWithinTarget,
      avgFirstReplyMs: repliedCount ? Math.round(totalFirstReplyMs / repliedCount) : null,
      awaitingReply,
      awaitingOverdue,
    },
    volume: dayKeys.map((day) => ({ day, count: perDay[day] })),
  };
}

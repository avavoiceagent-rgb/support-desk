import { useState } from "react";
import { api } from "../api/client";
import type { DashboardStats } from "../api/types";
import { Avatar } from "../components/Avatar";
import { usePolling } from "../hooks/usePolling";
import { STATUSES, formatDuration, queueLabel } from "../lib/statuses";
import type { TicketQueue } from "../api/types";

function Card({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm ${className ?? ""}`}>
      <div className="border-b border-gray-100 px-5 py-3">
        <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

function Bar({ label, count, max, colorClass }: { label: string; count: number; max: number; colorClass: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-44 shrink-0 truncate text-[13px] text-gray-600">{label}</span>
      <div className="h-4 flex-1 overflow-hidden rounded-full bg-gray-100">
        <div className={`h-full rounded-full ${colorClass}`} style={{ width: max ? `${Math.max((count / max) * 100, count ? 3 : 0)}%` : 0 }} />
      </div>
      <span className="w-8 shrink-0 text-right text-sm font-semibold tabular-nums text-gray-800">{count}</span>
    </div>
  );
}

function BigNumber({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" | "warn" }) {
  const color =
    tone === "good" ? "text-emerald-600" : tone === "bad" ? "text-red-600" : tone === "warn" ? "text-amber-600" : "text-gray-900";
  return (
    <div className="rounded-lg bg-gray-50 px-4 py-3">
      <p className={`text-2xl font-bold tabular-nums ${color}`}>{value}</p>
      <p className="mt-0.5 text-xs text-gray-500">{label}</p>
    </div>
  );
}

export function DashboardPage() {
  const [stats, setStats] = useState<DashboardStats | null>(null);

  usePolling(() => {
    api.get<{ stats: DashboardStats }>("/tickets/stats/overview").then((r) => setStats(r.stats));
  }, 30000);

  if (!stats) return <p className="text-sm text-gray-500">Loading…</p>;

  const statusMax = Math.max(...STATUSES.map((s) => stats.byStatus[s.value] ?? 0), 1);
  const queueEntries: { key: string; label: string; count: number }[] = [
    ...(["RESERVATION", "DISPATCH", "ACCOUNTING"] as TicketQueue[]).map((q) => ({
      key: q,
      label: queueLabel(q),
      count: stats.byQueue[q] ?? 0,
    })),
    { key: "NONE", label: "No queue", count: stats.byQueue["NONE"] ?? 0 },
  ];
  const queueMax = Math.max(...queueEntries.map((q) => q.count), 1);
  const volumeMax = Math.max(...stats.volume.map((v) => v.count), 1);
  const pctInTarget = stats.sla.repliedCount
    ? Math.round((stats.sla.repliedWithinTarget / stats.sla.repliedCount) * 100)
    : null;

  const dotColor: Record<string, string> = Object.fromEntries(STATUSES.map((s) => [s.value, s.dot]));

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-2xl font-bold tracking-tight text-gray-900">Dashboard</h1>
        <p className="mt-0.5 text-sm text-gray-500">{stats.totalTickets} tickets in total · SLA target {stats.sla.targetHours}h first reply</p>
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <Card title="Tickets by status">
          <div className="space-y-2.5">
            {STATUSES.map((s) => (
              <Bar key={s.value} label={s.label} count={stats.byStatus[s.value] ?? 0} max={statusMax} colorClass={dotColor[s.value]} />
            ))}
          </div>
        </Card>

        <Card title="Response time (SLA)">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <BigNumber
              label="Avg. first reply"
              value={stats.sla.avgFirstReplyMs !== null ? formatDuration(stats.sla.avgFirstReplyMs) : "—"}
            />
            <BigNumber
              label={`Replied within ${stats.sla.targetHours}h`}
              value={pctInTarget !== null ? `${pctInTarget}%` : "—"}
              tone={pctInTarget === null ? undefined : pctInTarget >= 80 ? "good" : pctInTarget >= 50 ? "warn" : "bad"}
            />
            <BigNumber label="Replies sent" value={String(stats.sla.repliedCount)} />
            <BigNumber
              label="Awaiting first reply"
              value={String(stats.sla.awaitingReply)}
              tone={stats.sla.awaitingReply > 0 ? "warn" : "good"}
            />
            <BigNumber
              label="Overdue (no reply)"
              value={String(stats.sla.awaitingOverdue)}
              tone={stats.sla.awaitingOverdue > 0 ? "bad" : "good"}
            />
            <BigNumber
              label="Phone tickets"
              value={String(stats.byChannel["PHONE"] ?? 0)}
            />
          </div>
        </Card>

        <Card title="Tickets per team member">
          <table className="w-full text-left text-sm">
            <thead className="text-xs font-medium uppercase tracking-wide text-gray-400">
              <tr>
                <th className="pb-2">Member</th>
                <th className="pb-2 text-right">Open</th>
                <th className="pb-2 text-right">Closed</th>
                <th className="pb-2 text-right">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {stats.agents.map((a) => (
                <tr key={a.id ?? "unassigned"}>
                  <td className="py-2">
                    <span className="flex items-center gap-2.5">
                      {a.id ? (
                        <Avatar name={a.name} size={7} />
                      ) : (
                        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-gray-100 text-xs text-gray-400">—</span>
                      )}
                      <span className="font-medium text-gray-800">{a.name}</span>
                    </span>
                  </td>
                  <td className="py-2 text-right tabular-nums text-amber-600">{a.open}</td>
                  <td className="py-2 text-right tabular-nums text-emerald-600">{a.closed}</td>
                  <td className="py-2 text-right font-semibold tabular-nums text-gray-800">{a.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        <div className="space-y-5">
          <Card title="Tickets by queue">
            <div className="space-y-2.5">
              {queueEntries.map((q) => (
                <Bar key={q.key} label={q.label} count={q.count} max={queueMax} colorClass="bg-indigo-400" />
              ))}
            </div>
          </Card>

          <Card title="New tickets — last 14 days">
            <div className="flex h-28 items-end gap-1.5">
              {stats.volume.map((v) => (
                <div key={v.day} className="group relative flex-1">
                  <div
                    className="w-full rounded-t bg-indigo-400 transition-colors group-hover:bg-indigo-600"
                    style={{ height: `${Math.max((v.count / volumeMax) * 100, v.count ? 8 : 2)}px` }}
                    title={`${v.day}: ${v.count}`}
                  />
                </div>
              ))}
            </div>
            <div className="mt-1.5 flex justify-between text-[10px] text-gray-400">
              <span>{stats.volume[0]?.day.slice(5)}</span>
              <span>{stats.volume[stats.volume.length - 1]?.day.slice(5)}</span>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

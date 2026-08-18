import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import type { ReportsData, TicketQueue } from "../api/types";
import { Avatar } from "../components/Avatar";
import { StatusBadge } from "../components/StatusBadge";
import { STATUSES, formatDuration, queueLabel } from "../lib/statuses";
import { formatDateTime } from "../lib/ui";

const RANGES = [
  { days: 7, label: "Last 7 days" },
  { days: 30, label: "Last 30 days" },
  { days: 90, label: "Last 90 days" },
  { days: 0, label: "All time" },
];

function ms(v: number | null): string {
  return v === null ? "—" : formatDuration(v);
}

/** Build a CSV file in the browser and download it. */
function downloadCsv(filename: string, rows: (string | number | null)[][]) {
  const esc = (v: string | number | null) => {
    const s = v === null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = rows.map((r) => r.map(esc).join(",")).join("\n");
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function Card({
  title,
  action,
  children,
  className,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm ${className ?? ""}`}>
      <div className="flex items-center justify-between border-b border-gray-100 px-5 py-3">
        <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
        {action}
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

function CsvButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs font-medium text-gray-600 transition-colors hover:border-indigo-300 hover:text-indigo-700"
    >
      <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <path d="m7 10 5 5 5-5" />
        <path d="M12 15V3" />
      </svg>
      CSV
    </button>
  );
}

function Kpi({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" | "warn" }) {
  const color =
    tone === "good" ? "text-emerald-600" : tone === "bad" ? "text-red-600" : tone === "warn" ? "text-amber-600" : "text-gray-900";
  return (
    <div className="rounded-xl border border-gray-200 bg-white px-4 py-3 shadow-sm">
      <p className={`text-2xl font-bold tabular-nums ${color}`}>{value}</p>
      <p className="mt-0.5 text-xs text-gray-500">{label}</p>
    </div>
  );
}

function Bar({ label, count, max, colorClass }: { label: string; count: number; max: number; colorClass: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-40 shrink-0 truncate text-[13px] text-gray-600">{label}</span>
      <div className="h-3.5 flex-1 overflow-hidden rounded-full bg-gray-100">
        <div className={`h-full rounded-full ${colorClass}`} style={{ width: max ? `${Math.max((count / max) * 100, count ? 3 : 0)}%` : 0 }} />
      </div>
      <span className="w-8 shrink-0 text-right text-sm font-semibold tabular-nums text-gray-800">{count}</span>
    </div>
  );
}

const th = "pb-2 text-left text-xs font-medium uppercase tracking-wide text-gray-400";
const thR = "pb-2 text-right text-xs font-medium uppercase tracking-wide text-gray-400";

export function ReportsPage() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<ReportsData | null>(null);

  useEffect(() => {
    setData(null);
    api.get<{ reports: ReportsData }>(`/tickets/reports/overview?days=${days}`).then((r) => setData(r.reports));
  }, [days]);

  if (!data) {
    return (
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-gray-900">Reports</h1>
        <p className="mt-4 text-sm text-gray-500">Loading…</p>
      </div>
    );
  }

  const t = data.totals;
  const trendMax = Math.max(...data.trend.map((x) => Math.max(x.created, x.resolved)), 1);
  const statusMax = Math.max(...Object.values(data.byStatus), 1);
  const queueEntries = [
    ...(["RESERVATION", "DISPATCH", "ACCOUNTING"] as TicketQueue[]).map((q) => ({ label: queueLabel(q), count: data.byQueue[q] ?? 0 })),
    { label: "No queue", count: data.byQueue["NONE"] ?? 0 },
  ];
  const queueMax = Math.max(...queueEntries.map((q) => q.count), 1);
  const rangeLabel = RANGES.find((r) => r.days === days)?.label ?? "";

  const exportAgents = () =>
    downloadCsv(`team-report-${days || "all"}d.csv`, [
      ["Member", "Assigned", "Open", "Closed", "Replies sent", "Notes added", "Avg first reply", "SLA met %", "Avg time to close"],
      ...data.agents.map((a) => [
        a.name,
        a.assigned,
        a.open,
        a.closed,
        a.repliesSent,
        a.notesAdded,
        ms(a.avgFirstReplyMs),
        a.slaMetPct === null ? "" : `${a.slaMetPct}%`,
        ms(a.avgResolutionMs),
      ]),
    ]);

  const exportCustomers = () =>
    downloadCsv(`customer-report-${days || "all"}d.csv`, [
      ["Customer", "Email", "Tickets", "Open", "Closed", "Avg first reply", "Last contact"],
      ...data.customers.map((c) => [c.label, c.email, c.tickets, c.open, c.closed, ms(c.avgFirstReplyMs), formatDateTime(c.lastContact)]),
    ]);

  const exportTickets = () =>
    downloadCsv(`ticket-report-${days || "all"}d.csv`, [
      ["Metric", "Value"],
      ["Range", rangeLabel],
      ["Tickets created", t.created],
      ["Tickets resolved", t.resolved],
      ["Still open", t.openNow],
      ["Unassigned open", t.unassignedOpen],
      ["SLA breaches (24h first reply)", t.slaBreaches],
      ["Avg first reply", ms(t.avgFirstReplyMs)],
      ["Avg time to close", ms(t.avgResolutionMs)],
      ["Repeat customers", t.repeatCustomerPct === null ? "" : `${t.repeatCustomerPct}%`],
      [],
      ["Status", "Count"],
      ...STATUSES.filter((s) => data.byStatus[s.value]).map((s) => [s.label, data.byStatus[s.value]]),
    ]);

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-gray-900">Reports</h1>
          <p className="mt-0.5 text-sm text-gray-500">Team, ticket, and customer performance · {rangeLabel.toLowerCase()}</p>
        </div>
        <div className="flex items-center gap-1 rounded-xl bg-gray-100 p-1">
          {RANGES.map((r) => (
            <button
              key={r.days}
              onClick={() => setDays(r.days)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                days === r.days ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-800"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {/* KPIs */}
      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8">
        <Kpi label="Created" value={String(t.created)} />
        <Kpi label="Resolved" value={String(t.resolved)} tone="good" />
        <Kpi label="Still open" value={String(t.openNow)} tone={t.openNow > 0 ? "warn" : "good"} />
        <Kpi label="Unassigned" value={String(t.unassignedOpen)} tone={t.unassignedOpen > 0 ? "warn" : "good"} />
        <Kpi label="SLA breaches" value={String(t.slaBreaches)} tone={t.slaBreaches > 0 ? "bad" : "good"} />
        <Kpi label="Avg first reply" value={ms(t.avgFirstReplyMs)} />
        <Kpi label="Avg time to close" value={ms(t.avgResolutionMs)} />
        <Kpi label="Repeat customers" value={t.repeatCustomerPct === null ? "—" : `${t.repeatCustomerPct}%`} />
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        {/* Team member report */}
        <Card title="Team performance" action={<CsvButton onClick={exportAgents} />} className="xl:col-span-2">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead>
                <tr>
                  <th className={th}>Member</th>
                  <th className={thR}>Assigned</th>
                  <th className={thR}>Open</th>
                  <th className={thR}>Closed</th>
                  <th className={thR}>Replies</th>
                  <th className={thR}>Notes</th>
                  <th className={thR}>Avg first reply</th>
                  <th className={thR}>SLA met</th>
                  <th className={thR}>Avg time to close</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {data.agents.map((a) => (
                  <tr key={a.id}>
                    <td className="py-2.5">
                      <span className="flex items-center gap-2.5">
                        <Avatar name={a.name} size={7} />
                        <span className="font-medium text-gray-800">{a.name}</span>
                      </span>
                    </td>
                    <td className="py-2.5 text-right tabular-nums text-gray-800">{a.assigned}</td>
                    <td className="py-2.5 text-right tabular-nums text-amber-600">{a.open}</td>
                    <td className="py-2.5 text-right tabular-nums text-emerald-600">{a.closed}</td>
                    <td className="py-2.5 text-right tabular-nums text-gray-800">{a.repliesSent}</td>
                    <td className="py-2.5 text-right tabular-nums text-gray-800">{a.notesAdded}</td>
                    <td className="py-2.5 text-right tabular-nums text-gray-700">{ms(a.avgFirstReplyMs)}</td>
                    <td
                      className={`py-2.5 text-right tabular-nums font-semibold ${
                        a.slaMetPct === null ? "text-gray-400" : a.slaMetPct >= 80 ? "text-emerald-600" : a.slaMetPct >= 50 ? "text-amber-600" : "text-red-600"
                      }`}
                    >
                      {a.slaMetPct === null ? "—" : `${a.slaMetPct}%`}
                    </td>
                    <td className="py-2.5 text-right tabular-nums text-gray-700">{ms(a.avgResolutionMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        {/* Ticket trend */}
        <Card title="Created vs. resolved" action={<CsvButton onClick={exportTickets} />}>
          <div className="flex h-36 items-end gap-1">
            {data.trend.map((b) => (
              <div key={b.bucket} className="flex flex-1 items-end justify-center gap-[2px]" title={`${b.bucket}: ${b.created} created, ${b.resolved} resolved`}>
                <div className="w-1/2 max-w-[14px] rounded-t bg-indigo-400" style={{ height: `${Math.max((b.created / trendMax) * 128, b.created ? 6 : 2)}px` }} />
                <div className="w-1/2 max-w-[14px] rounded-t bg-emerald-400" style={{ height: `${Math.max((b.resolved / trendMax) * 128, b.resolved ? 6 : 2)}px` }} />
              </div>
            ))}
          </div>
          <div className="mt-1.5 flex justify-between text-[10px] text-gray-400">
            <span>{data.trend[0]?.bucket}</span>
            <span>{data.trend[data.trend.length - 1]?.bucket}</span>
          </div>
          <div className="mt-3 flex gap-4 text-xs text-gray-600">
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-sm bg-indigo-400" /> Created
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-sm bg-emerald-400" /> Resolved
            </span>
          </div>
        </Card>

        {/* Breakdowns */}
        <Card title="Breakdown">
          <div className="space-y-2">
            {STATUSES.filter((s) => data.byStatus[s.value]).map((s) => (
              <Bar key={s.value} label={s.label} count={data.byStatus[s.value]} max={statusMax} colorClass={s.dot} />
            ))}
          </div>
          <div className="mt-4 border-t border-gray-100 pt-3">
            <div className="space-y-2">
              {queueEntries.map((q) => (
                <Bar key={q.label} label={q.label} count={q.count} max={queueMax} colorClass="bg-indigo-400" />
              ))}
            </div>
          </div>
          <div className="mt-4 flex gap-3 border-t border-gray-100 pt-3 text-sm text-gray-600">
            <span>
              Email: <b className="tabular-nums">{data.byChannel["EMAIL"] ?? 0}</b>
            </span>
            <span>
              Phone: <b className="tabular-nums">{data.byChannel["PHONE"] ?? 0}</b>
            </span>
          </div>
        </Card>

        {/* Customer report */}
        <Card title="Top customers" action={<CsvButton onClick={exportCustomers} />} className="xl:col-span-2">
          {data.customers.length === 0 ? (
            <p className="text-sm text-gray-500">No tickets in this period.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr>
                    <th className={th}>Customer</th>
                    <th className={thR}>Tickets</th>
                    <th className={thR}>Open</th>
                    <th className={thR}>Closed</th>
                    <th className={thR}>Avg first reply</th>
                    <th className={thR}>Last contact</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {data.customers.map((c) => (
                    <tr key={c.label + (c.email ?? "")}>
                      <td className="py-2.5">
                        <span className="flex items-center gap-2.5">
                          <Avatar name={c.label} size={7} />
                          <span className="min-w-0">
                            <span className="block truncate font-medium text-gray-800">{c.label}</span>
                            {c.email && c.email !== c.label && <span className="block truncate text-xs text-gray-400">{c.email}</span>}
                          </span>
                        </span>
                      </td>
                      <td className="py-2.5 text-right font-semibold tabular-nums text-gray-800">{c.tickets}</td>
                      <td className="py-2.5 text-right tabular-nums text-amber-600">{c.open}</td>
                      <td className="py-2.5 text-right tabular-nums text-emerald-600">{c.closed}</td>
                      <td className="py-2.5 text-right tabular-nums text-gray-700">{ms(c.avgFirstReplyMs)}</td>
                      <td className="py-2.5 whitespace-nowrap text-right text-gray-500">{formatDateTime(c.lastContact)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {/* Oldest open */}
        <Card title="Longest-waiting open tickets" className="xl:col-span-2">
          {data.oldestOpen.length === 0 ? (
            <p className="text-sm text-gray-500">Nothing waiting — all clear.</p>
          ) : (
            <ul className="divide-y divide-gray-100">
              {data.oldestOpen.map((o) => (
                <li key={o.id} className="flex items-center gap-3 py-2.5">
                  <span className="shrink-0 text-xs tabular-nums text-gray-400">#{o.ticketNumber}</span>
                  <Link to={`/tickets/${o.id}`} className="min-w-0 flex-1 truncate text-sm font-medium text-gray-800 hover:text-indigo-600">
                    {o.subject}
                  </Link>
                  <StatusBadge status={o.status} />
                  <span className="w-20 shrink-0 text-right text-sm font-semibold tabular-nums text-red-600">{formatDuration(o.ageMs)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

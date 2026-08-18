import { Fragment, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import type { PublicUser, TicketListItem, TicketQueue, TicketStatus } from "../api/types";
import { StatusBadge } from "../components/StatusBadge";
import { Avatar } from "../components/Avatar";
import { TicketPane } from "../components/TicketPane";
import { NewTicketModal } from "../components/NewTicketModal";
import { usePolling } from "../hooks/usePolling";
import { timeAgo, formatDateTime } from "../lib/ui";
import {
  GROUP_LABELS,
  QUEUES,
  STATUSES,
  isClosedStatus,
  queueLabel,
  slaInfo,
  statusMeta,
  statusesInGroup,
  type StatusGroup,
} from "../lib/statuses";

type Tab = "ALL" | StatusGroup;
type GroupBy = "none" | "date" | "sender";
type SortKey = "number" | "requester" | "status" | "received" | "sla" | "updated";

const TABS: { key: Tab; label: string }[] = [
  { key: "ALL", label: "All" },
  { key: "ACTIVE", label: "Active" },
  { key: "WAITING", label: "Waiting" },
  { key: "CLOSED", label: "Closed" },
];

const statusOrder = new Map(STATUSES.map((s, i) => [s.value, i]));

function requesterLabel(t: TicketListItem): string {
  return t.requesterName ?? t.requesterEmail ?? t.requesterPhone ?? "Unknown";
}

function slaMs(t: TicketListItem): number {
  const received = new Date(t.receivedAt).getTime();
  if (t.firstReplyAt) return new Date(t.firstReplyAt).getTime() - received;
  if (isClosedStatus(t.status)) return -1;
  return Date.now() - received;
}

function dateBucket(iso: string): { order: number; label: string } {
  const d = new Date(iso);
  const now = new Date();
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const today = startOfDay(now);
  const t = startOfDay(d);
  const dayMs = 86_400_000;
  if (t >= today) return { order: 0, label: "Today" };
  if (t >= today - dayMs) return { order: 1, label: "Yesterday" };
  if (t >= today - 6 * dayMs) return { order: 2, label: "This week" };
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth())
    return { order: 3, label: "Earlier this month" };
  return { order: 4, label: "Older" };
}

const selectClass =
  "rounded-lg border border-gray-300 bg-white px-2.5 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none";

export function TicketListPage() {
  const navigate = useNavigate();
  const [tickets, setTickets] = useState<TicketListItem[]>([]);
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [tab, setTab] = useState<Tab>("ACTIVE");
  const [statusFilter, setStatusFilter] = useState<"ALL" | TicketStatus>("ALL");
  const [queueFilter, setQueueFilter] = useState<"ALL" | "NONE" | TicketQueue>("ALL");
  const [assigneeFilter, setAssigneeFilter] = useState<string>("ALL");
  const [groupBy, setGroupBy] = useState<GroupBy>("none");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "updated", dir: -1 });
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openId, setOpenId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    api.get<{ users: PublicUser[] }>("/users").then((r) => setUsers(r.users));
  }, []);

  function load() {
    api
      .get<{ tickets: TicketListItem[] }>("/tickets")
      .then((r) => {
        setTickets(r.tickets);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }

  usePolling(load, 20000);

  // Esc closes the reading pane.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const counts = useMemo(() => {
    const c: Record<Tab, number> = { ALL: tickets.length, ACTIVE: 0, WAITING: 0, CLOSED: 0 };
    for (const t of tickets) c[statusMeta(t.status).group]++;
    return c;
  }, [tickets]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = tickets.filter((t) => {
      if (tab !== "ALL" && statusMeta(t.status).group !== tab) return false;
      if (statusFilter !== "ALL" && t.status !== statusFilter) return false;
      if (queueFilter === "NONE" && t.queue !== null) return false;
      if (queueFilter !== "ALL" && queueFilter !== "NONE" && t.queue !== queueFilter) return false;
      if (assigneeFilter === "unassigned" && t.assignee) return false;
      if (assigneeFilter !== "ALL" && assigneeFilter !== "unassigned" && t.assignee?.id !== assigneeFilter)
        return false;
      if (q) {
        const hay = `${t.subject} ${t.requesterName ?? ""} ${t.requesterEmail ?? ""} ${t.requesterPhone ?? ""} ${
          t.lastMessagePreview?.snippet ?? ""
        }`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    const val = (t: TicketListItem): number | string => {
      switch (sort.key) {
        case "number":
          return t.ticketNumber;
        case "requester":
          return requesterLabel(t).toLowerCase();
        case "status":
          return statusOrder.get(t.status) ?? 99;
        case "received":
          return new Date(t.receivedAt).getTime();
        case "sla":
          return slaMs(t);
        case "updated":
          return new Date(t.updatedAt).getTime();
      }
    };
    return filtered.sort((a, b) => {
      const av = val(a);
      const bv = val(b);
      if (av < bv) return -1 * sort.dir;
      if (av > bv) return 1 * sort.dir;
      return 0;
    });
  }, [tickets, tab, statusFilter, queueFilter, assigneeFilter, search, sort]);

  /** Visible tickets partitioned into display groups (single group when groupBy is none). */
  const groups = useMemo((): { label: string | null; items: TicketListItem[] }[] => {
    if (groupBy === "none") return [{ label: null, items: visible }];
    const map = new Map<string, { order: number; label: string; items: TicketListItem[] }>();
    for (const t of visible) {
      const g =
        groupBy === "date"
          ? dateBucket(t.receivedAt)
          : { order: 0, label: requesterLabel(t) };
      const key = g.label;
      const entry = map.get(key) ?? { ...g, items: [] };
      entry.items.push(t);
      map.set(key, entry);
    }
    const list = [...map.values()];
    if (groupBy === "date") list.sort((a, b) => a.order - b.order);
    else
      list.sort(
        (a, b) =>
          Math.max(...b.items.map((t) => new Date(t.updatedAt).getTime())) -
          Math.max(...a.items.map((t) => new Date(t.updatedAt).getTime()))
      );
    return list.map((g) => ({ label: `${g.label} (${g.items.length})`, items: g.items }));
  }, [visible, groupBy]);

  const paneOpen = openId !== null;
  const allVisibleSelected = visible.length > 0 && visible.every((t) => selected.has(t.id));

  function toggleAll() {
    setSelected(allVisibleSelected ? new Set() : new Set(visible.map((t) => t.id)));
  }

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function openTicket(id: string) {
    if (window.matchMedia("(min-width: 1024px)").matches) {
      setOpenId(id);
    } else {
      navigate(`/tickets/${id}`);
    }
  }

  function toggleSort(key: SortKey) {
    setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: key === "requester" || key === "status" ? 1 : -1 }));
  }

  async function bulkSetStatus(status: TicketStatus) {
    setWorking(true);
    try {
      for (const id of selected) {
        await api.patch(`/tickets/${id}`, { status });
      }
      setSelected(new Set());
      load();
    } finally {
      setWorking(false);
    }
  }

  const SortHeader = ({
    label,
    sortKey,
    className,
  }: {
    label: string;
    sortKey: SortKey;
    className?: string;
  }) => (
    <th className={className}>
      <button
        onClick={() => toggleSort(sortKey)}
        className="inline-flex items-center gap-1 uppercase tracking-wide hover:text-indigo-600"
      >
        {label}
        {sort.key === sortKey && (
          <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            {sort.dir === 1 ? <path d="m18 15-6-6-6 6" /> : <path d="m6 9 6 6 6-6" />}
          </svg>
        )}
      </button>
    </th>
  );

  const colCount = 7;

  const renderRow = (t: TicketListItem) => {
    const sla = slaInfo(t.receivedAt, t.firstReplyAt, isClosedStatus(t.status));
    const slaColor =
      sla.state === "met"
        ? "text-emerald-600"
        : sla.state === "overdue"
          ? "text-red-600 font-semibold"
          : sla.state === "pending"
            ? "text-amber-600"
            : "text-gray-400";
    return (
      <tr
        key={t.id}
        onClick={() => openTicket(t.id)}
        className={`cursor-pointer transition-colors ${openId === t.id ? "bg-indigo-50/80" : "hover:bg-indigo-50/40"}`}
      >
        <td className="px-4 py-3.5" onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
            checked={selected.has(t.id)}
            onChange={() => toggleOne(t.id)}
          />
        </td>
        <td className="px-2 py-3.5">
          <div className="flex items-baseline gap-2">
            <span className="shrink-0 text-xs tabular-nums text-gray-400">#{t.ticketNumber}</span>
            {t.channel === "PHONE" && (
              <svg className="h-3.5 w-3.5 shrink-0 self-center text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
              </svg>
            )}
            <span className={`truncate font-semibold ${openId === t.id ? "text-indigo-900" : "text-gray-900"}`}>
              {t.subject}
            </span>
            {t.queue && (
              <span className="hidden shrink-0 rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-indigo-500 @3xl:inline">
                {queueLabel(t.queue)}
              </span>
            )}
            <span className="ml-auto shrink-0 text-[11px] text-gray-400 @2xl:hidden">{timeAgo(t.updatedAt)}</span>
          </div>
          <p className="mt-0.5 truncate text-[13px] text-gray-500">
            <span className="@4xl:hidden">{requesterLabel(t)} · </span>
            {t.lastMessagePreview && (
              <>
                {t.lastMessagePreview.direction === "OUTBOUND" && <span className="font-medium text-indigo-500">You: </span>}
                {t.lastMessagePreview.snippet}
              </>
            )}
          </p>
        </td>
        <td className="hidden px-2 py-3.5 @4xl:table-cell">
          <span className="flex items-center gap-2">
            <Avatar name={requesterLabel(t)} size={7} />
            <span className="max-w-[9rem] truncate text-gray-700">{requesterLabel(t)}</span>
          </span>
        </td>
        <td className="px-2 py-3.5">
          <StatusBadge status={t.status} />
        </td>
        <td className="hidden px-2 py-3.5 @5xl:table-cell">
          {t.assignee ? (
            <span className="flex items-center gap-2">
              <Avatar name={t.assignee.name} size={6} />
              <span className="max-w-[7rem] truncate text-gray-700">{t.assignee.name}</span>
            </span>
          ) : (
            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500">Unassigned</span>
          )}
        </td>
        <td
          className="hidden whitespace-nowrap px-2 py-3.5 text-right text-[13px] text-gray-500 @3xl:table-cell"
          title={formatDateTime(t.receivedAt)}
        >
          {timeAgo(t.receivedAt)}
        </td>
        <td className={`hidden whitespace-nowrap px-2 py-3.5 text-right text-[13px] @2xl:table-cell ${slaColor}`} title="Time to first reply (target 24h)">
          {sla.label}
        </td>
        <td className="hidden whitespace-nowrap px-4 py-3.5 text-right text-[13px] text-gray-400 @2xl:table-cell">
          {timeAgo(t.updatedAt)}
        </td>
      </tr>
    );
  };

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-gray-900">Tickets</h1>
          <p className="mt-0.5 text-sm text-gray-500">
            {counts.ACTIVE} active · {counts.WAITING} waiting · {counts.CLOSED} closed
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <svg
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.3-4.3" strokeLinecap="round" />
            </svg>
            <input
              className="w-48 rounded-lg border border-gray-300 bg-white py-2 pl-9 pr-3 text-sm shadow-sm placeholder:text-gray-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
              placeholder="Search tickets…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <select className={selectClass} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as "ALL" | TicketStatus)}>
            <option value="ALL">Any status</option>
            {(["ACTIVE", "WAITING", "CLOSED"] as const).map((g) => (
              <optgroup key={g} label={GROUP_LABELS[g]}>
                {statusesInGroup(g).map((s) => (
                  <option key={s} value={s}>
                    {statusMeta(s).label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <select className={selectClass} value={queueFilter} onChange={(e) => setQueueFilter(e.target.value as "ALL" | "NONE" | TicketQueue)}>
            <option value="ALL">Any queue</option>
            {QUEUES.map((q) => (
              <option key={q.value} value={q.value}>
                {q.label}
              </option>
            ))}
            <option value="NONE">No queue</option>
          </select>
          <select className={selectClass} value={assigneeFilter} onChange={(e) => setAssigneeFilter(e.target.value)}>
            <option value="ALL">Everyone</option>
            <option value="unassigned">Unassigned</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
          <select className={selectClass} value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)}>
            <option value="none">No grouping</option>
            <option value="date">Group by date</option>
            <option value="sender">Group by sender</option>
          </select>
          <button
            onClick={() => setShowNew(true)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3.5 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-700"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <path d="M12 5v14" />
              <path d="M5 12h14" />
            </svg>
            New ticket
          </button>
        </div>
      </div>

      <div className="mb-4 flex items-center gap-1 rounded-xl bg-gray-100 p-1">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => {
              setTab(t.key);
              setStatusFilter("ALL");
              setSelected(new Set());
            }}
            className={`flex-1 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
              tab === t.key ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-800"
            }`}
          >
            {t.label}
            <span
              className={`ml-1.5 rounded-full px-1.5 py-0.5 text-xs tabular-nums ${
                tab === t.key ? "bg-indigo-50 text-indigo-700" : "bg-gray-200/70 text-gray-500"
              }`}
            >
              {counts[t.key]}
            </span>
          </button>
        ))}
      </div>

      {selected.size > 0 && (
        <div className="mb-3 flex items-center justify-between rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-2.5">
          <span className="text-sm font-medium text-indigo-900">
            {selected.size} ticket{selected.size > 1 ? "s" : ""} selected
          </span>
          <div className="flex gap-2">
            <button
              disabled={working}
              onClick={() => void bulkSetStatus("RESOLVED_CLOSED")}
              className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-indigo-700 disabled:opacity-50"
            >
              {working ? "Working…" : "Close selected (resolved)"}
            </button>
            <button
              disabled={working}
              onClick={() => void bulkSetStatus("OPEN")}
              className="rounded-lg border border-indigo-300 bg-white px-3 py-1.5 text-sm font-medium text-indigo-700 shadow-sm transition-colors hover:bg-indigo-100 disabled:opacity-50"
            >
              Reopen
            </button>
            <button
              disabled={working}
              onClick={() => setSelected(new Set())}
              className="rounded-lg px-2 py-1.5 text-sm text-indigo-600 hover:underline"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div
        className={
          paneOpen ? "grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_clamp(480px,42%,760px)]" : ""
        }
      >
        {/* Ticket list — columns adapt to the space this card actually has */}
        <div className="@container overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
          {loading ? (
            <div className="p-12 text-center text-sm text-gray-500">Loading…</div>
          ) : visible.length === 0 ? (
            <div className="p-14 text-center">
              <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-gray-100">
                <svg className="h-6 w-6 text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M22 12h-6l-2 3h-4l-2-3H2" />
                  <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
                </svg>
              </div>
              <p className="text-sm font-medium text-gray-900">No tickets here</p>
              <p className="mt-1 text-sm text-gray-500">
                {search ? "Try a different search." : "New emails to the connected mailbox appear automatically."}
              </p>
            </div>
          ) : (
            <table className="w-full table-fixed text-left text-sm">
              <thead className="border-b border-gray-200 bg-gray-50/70 text-xs font-medium uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="w-12 px-4 py-2.5">
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                      checked={allVisibleSelected}
                      onChange={toggleAll}
                    />
                  </th>
                  <SortHeader label="Ticket" sortKey="number" className="px-2 py-2.5" />
                  <SortHeader label="Requester" sortKey="requester" className="hidden w-44 px-2 py-2.5 @4xl:table-cell" />
                  <SortHeader label="Status" sortKey="status" className="w-36 px-2 py-2.5" />
                  <th className="hidden w-36 px-2 py-2.5 @5xl:table-cell">Assignee</th>
                  <SortHeader label="Received" sortKey="received" className="hidden w-24 px-2 py-2.5 text-right @3xl:table-cell" />
                  <SortHeader label="SLA" sortKey="sla" className="hidden w-20 px-2 py-2.5 text-right @2xl:table-cell" />
                  <SortHeader label="Updated" sortKey="updated" className="hidden w-24 px-4 py-2.5 text-right @2xl:table-cell" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {groups.map((g, gi) => (
                  <Fragment key={g.label ?? gi}>
                    {g.label && (
                      <tr className="bg-gray-50/80">
                        <td colSpan={colCount + 1} className="px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500">
                          {g.label}
                        </td>
                      </tr>
                    )}
                    {g.items.map(renderRow)}
                  </Fragment>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Reading pane */}
        {paneOpen && (
          <div className="hidden lg:block">
            <TicketPane
              ticketId={openId!}
              users={users}
              onClose={() => setOpenId(null)}
              onChanged={load}
              onOpenTicket={(id) => setOpenId(id)}
            />
          </div>
        )}
      </div>

      {showNew && (
        <NewTicketModal
          users={users}
          onClose={() => setShowNew(false)}
          onCreated={(id) => {
            setShowNew(false);
            load();
            if (window.matchMedia("(min-width: 1024px)").matches) setOpenId(id);
            else navigate(`/tickets/${id}`);
          }}
        />
      )}
    </div>
  );
}

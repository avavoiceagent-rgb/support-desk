import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import type { PublicUser, TicketListItem, TicketStatus } from "../api/types";
import { StatusBadge } from "../components/StatusBadge";
import { Avatar } from "../components/Avatar";
import { TicketPane } from "../components/TicketPane";
import { usePolling } from "../hooks/usePolling";
import { timeAgo } from "../lib/ui";

type Tab = "ALL" | TicketStatus;

const TABS: { key: Tab; label: string }[] = [
  { key: "ALL", label: "All" },
  { key: "OPEN", label: "Open" },
  { key: "IN_PROGRESS", label: "In Progress" },
  { key: "CLOSED", label: "Closed" },
];

export function TicketListPage() {
  const navigate = useNavigate();
  const [tickets, setTickets] = useState<TicketListItem[]>([]);
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [tab, setTab] = useState<Tab>("OPEN");
  const [assigneeFilter, setAssigneeFilter] = useState<string>("ALL");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openId, setOpenId] = useState<string | null>(null);
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
    const c: Record<Tab, number> = { ALL: tickets.length, OPEN: 0, IN_PROGRESS: 0, CLOSED: 0 };
    for (const t of tickets) c[t.status]++;
    return c;
  }, [tickets]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return tickets.filter((t) => {
      if (tab !== "ALL" && t.status !== tab) return false;
      if (assigneeFilter === "unassigned" && t.assignee) return false;
      if (assigneeFilter !== "ALL" && assigneeFilter !== "unassigned" && t.assignee?.id !== assigneeFilter)
        return false;
      if (q) {
        const hay = `${t.subject} ${t.requesterName ?? ""} ${t.requesterEmail} ${t.lastMessagePreview?.snippet ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [tickets, tab, assigneeFilter, search]);

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

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-gray-900">Tickets</h1>
          <p className="mt-0.5 text-sm text-gray-500">
            {counts.OPEN} open · {counts.IN_PROGRESS} in progress · {counts.CLOSED} closed
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
              className="w-56 rounded-lg border border-gray-300 bg-white py-2 pl-9 pr-3 text-sm shadow-sm placeholder:text-gray-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
              placeholder="Search tickets…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <select
            className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none"
            value={assigneeFilter}
            onChange={(e) => setAssigneeFilter(e.target.value)}
          >
            <option value="ALL">Everyone</option>
            <option value="unassigned">Unassigned</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="mb-4 flex items-center gap-1 rounded-xl bg-gray-100 p-1">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => {
              setTab(t.key);
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
              onClick={() => void bulkSetStatus("CLOSED")}
              className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-indigo-700 disabled:opacity-50"
            >
              {working ? "Working…" : "Close selected"}
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
                  <th className="px-2 py-2.5">Ticket</th>
                  <th className="hidden w-44 px-2 py-2.5 @3xl:table-cell">Requester</th>
                  <th className="w-28 px-2 py-2.5">Status</th>
                  <th className="hidden w-36 px-2 py-2.5 @4xl:table-cell">Assignee</th>
                  <th className="hidden w-24 px-4 py-2.5 text-right @2xl:table-cell">Updated</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {visible.map((t) => (
                  <tr
                    key={t.id}
                    onClick={() => openTicket(t.id)}
                    className={`cursor-pointer transition-colors ${
                      openId === t.id ? "bg-indigo-50/80" : "hover:bg-indigo-50/40"
                    }`}
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
                        <span
                          className={`truncate font-semibold ${
                            openId === t.id ? "text-indigo-900" : "text-gray-900"
                          }`}
                        >
                          {t.subject}
                        </span>
                        <span className="ml-auto shrink-0 text-[11px] text-gray-400 @2xl:hidden">
                          {timeAgo(t.updatedAt)}
                        </span>
                      </div>
                      <p className="mt-0.5 truncate text-[13px] text-gray-500">
                        <span className="@3xl:hidden">{t.requesterName ?? t.requesterEmail} · </span>
                        {t.lastMessagePreview && (
                          <>
                            {t.lastMessagePreview.direction === "OUTBOUND" && (
                              <span className="font-medium text-indigo-500">You: </span>
                            )}
                            {t.lastMessagePreview.snippet}
                          </>
                        )}
                      </p>
                    </td>
                    <td className="hidden px-2 py-3.5 @3xl:table-cell">
                      <span className="flex items-center gap-2">
                        <Avatar name={t.requesterName ?? t.requesterEmail} size={7} />
                        <span className="max-w-[10rem] truncate text-gray-700">
                          {t.requesterName ?? t.requesterEmail}
                        </span>
                      </span>
                    </td>
                    <td className="px-2 py-3.5">
                      <StatusBadge status={t.status} />
                    </td>
                    <td className="hidden px-2 py-3.5 @4xl:table-cell">
                      {t.assignee ? (
                        <span className="flex items-center gap-2">
                          <Avatar name={t.assignee.name} size={6} />
                          <span className="max-w-[8rem] truncate text-gray-700">{t.assignee.name}</span>
                        </span>
                      ) : (
                        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500">Unassigned</span>
                      )}
                    </td>
                    <td className="hidden whitespace-nowrap px-4 py-3.5 text-right text-[13px] text-gray-400 @2xl:table-cell">
                      {timeAgo(t.updatedAt)}
                    </td>
                  </tr>
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
    </div>
  );
}

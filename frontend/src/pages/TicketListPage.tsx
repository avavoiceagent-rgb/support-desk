import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import type { PublicUser, TicketListItem, TicketStatus } from "../api/types";
import { StatusBadge } from "../components/StatusBadge";
import { usePolling } from "../hooks/usePolling";

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function TicketListPage() {
  const [tickets, setTickets] = useState<TicketListItem[]>([]);
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [statusFilter, setStatusFilter] = useState<TicketStatus | "ALL">("ALL");
  const [assigneeFilter, setAssigneeFilter] = useState<string>("ALL");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get<{ users: PublicUser[] }>("/users").then((r) => setUsers(r.users));
  }, []);

  usePolling(() => {
    const params = new URLSearchParams();
    if (statusFilter !== "ALL") params.set("status", statusFilter);
    if (assigneeFilter !== "ALL") params.set("assigneeId", assigneeFilter);
    api
      .get<{ tickets: TicketListItem[] }>(`/tickets?${params.toString()}`)
      .then((r) => {
        setTickets(r.tickets);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, 20000);

  // Re-fetch immediately when filters change (usePolling only reacts to interval).
  useEffect(() => {
    const params = new URLSearchParams();
    if (statusFilter !== "ALL") params.set("status", statusFilter);
    if (assigneeFilter !== "ALL") params.set("assigneeId", assigneeFilter);
    setLoading(true);
    api
      .get<{ tickets: TicketListItem[] }>(`/tickets?${params.toString()}`)
      .then((r) => setTickets(r.tickets))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, assigneeFilter]);

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-gray-900">Tickets</h1>
        <div className="flex gap-2">
          <select
            className="rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as TicketStatus | "ALL")}
          >
            <option value="ALL">All statuses</option>
            <option value="OPEN">Open</option>
            <option value="IN_PROGRESS">In Progress</option>
            <option value="CLOSED">Closed</option>
          </select>
          <select
            className="rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm"
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

      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
        {loading ? (
          <div className="p-8 text-center text-sm text-gray-500">Loading…</div>
        ) : tickets.length === 0 ? (
          <div className="p-8 text-center text-sm text-gray-500">No tickets match these filters.</div>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-xs uppercase text-gray-500">
              <tr>
                <th className="px-4 py-2 font-medium">#</th>
                <th className="px-4 py-2 font-medium">Subject</th>
                <th className="px-4 py-2 font-medium">Requester</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Assignee</th>
                <th className="px-4 py-2 font-medium">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {tickets.map((t) => (
                <tr key={t.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 text-gray-400">{t.ticketNumber}</td>
                  <td className="px-4 py-3">
                    <Link to={`/tickets/${t.id}`} className="font-medium text-gray-900 hover:underline">
                      {t.subject}
                    </Link>
                    {t.lastMessagePreview && (
                      <div className="mt-0.5 truncate text-xs text-gray-500">
                        {t.lastMessagePreview.direction === "OUTBOUND" ? "You: " : ""}
                        {t.lastMessagePreview.snippet}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-600">{t.requesterName ?? t.requesterEmail}</td>
                  <td className="px-4 py-3">
                    <StatusBadge status={t.status} />
                  </td>
                  <td className="px-4 py-3 text-gray-600">{t.assignee?.name ?? "—"}</td>
                  <td className="px-4 py-3 text-gray-400">{timeAgo(t.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api/client";
import type { PublicUser, TicketDetail, TicketStatus } from "../api/types";
import { StatusBadge } from "../components/StatusBadge";
import { StatusSelect } from "../components/StatusSelect";
import { AssigneeSelect } from "../components/AssigneeSelect";
import { ConversationTimeline } from "../components/ConversationTimeline";
import { ReplyComposer } from "../components/ReplyComposer";
import { NotesPanel } from "../components/NotesPanel";
import { Avatar } from "../components/Avatar";
import { usePolling } from "../hooks/usePolling";
import { formatDateTime } from "../lib/ui";

export function TicketDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [ticket, setTicket] = useState<TicketDetail | null>(null);
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [notFound, setNotFound] = useState(false);

  const load = useCallback(() => {
    if (!id) return;
    api
      .get<{ ticket: TicketDetail }>(`/tickets/${id}`)
      .then((r) => setTicket(r.ticket))
      .catch(() => setNotFound(true));
  }, [id]);

  useEffect(() => {
    api.get<{ users: PublicUser[] }>("/users").then((r) => setUsers(r.users));
  }, []);

  usePolling(load, 20000);

  async function handleStatusChange(status: TicketStatus) {
    if (!id) return;
    setTicket((t) => (t ? { ...t, status } : t));
    await api.patch(`/tickets/${id}`, { status });
    load();
  }

  async function handleAssigneeChange(assigneeId: string | null) {
    if (!id) return;
    await api.patch(`/tickets/${id}`, { assigneeId });
    load();
  }

  if (notFound) {
    return <p className="text-sm text-gray-500">Ticket not found.</p>;
  }
  if (!ticket) {
    return <p className="text-sm text-gray-500">Loading…</p>;
  }

  return (
    <div>
      <Link
        to="/tickets"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-500 transition-colors hover:text-indigo-600"
      >
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m12 19-7-7 7-7" />
          <path d="M19 12H5" />
        </svg>
        Back to tickets
      </Link>

      <div className="mt-3 mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="truncate text-xl font-bold tracking-tight text-gray-900">{ticket.subject}</h1>
            <StatusBadge status={ticket.status} />
          </div>
          <p className="mt-1 text-sm text-gray-500">
            Ticket #{ticket.ticketNumber} · opened {formatDateTime(ticket.createdAt)}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_320px]">
        <div className="min-w-0 space-y-5">
          <ConversationTimeline ticketId={ticket.id} messages={ticket.messages} />
          <ReplyComposer ticketId={ticket.id} onSent={load} />
        </div>

        <div className="space-y-5">
          <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
            <div className="border-b border-gray-100 px-4 py-2.5">
              <h3 className="text-sm font-semibold text-gray-900">Details</h3>
            </div>
            <div className="space-y-4 p-4">
              <div>
                <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-gray-400">Requester</p>
                <div className="flex items-center gap-2.5">
                  <Avatar name={ticket.requesterName ?? ticket.requesterEmail} size={8} />
                  <div className="min-w-0">
                    {ticket.requesterName && (
                      <p className="truncate text-sm font-medium text-gray-900">{ticket.requesterName}</p>
                    )}
                    <p className="truncate text-xs text-gray-500">{ticket.requesterEmail}</p>
                  </div>
                </div>
              </div>
              <div>
                <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-gray-400">Status</p>
                <StatusSelect value={ticket.status} onChange={handleStatusChange} />
              </div>
              <div>
                <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-gray-400">Assigned to</p>
                <AssigneeSelect users={users} value={ticket.assigneeId} onChange={handleAssigneeChange} />
              </div>
              <div>
                <p className="mb-1 text-xs font-medium uppercase tracking-wide text-gray-400">Mailbox</p>
                <p className="truncate text-sm text-gray-700">{ticket.emailAccount.email}</p>
              </div>
            </div>
          </div>

          <NotesPanel ticketId={ticket.id} notes={ticket.notes} onAdded={load} />
        </div>
      </div>
    </div>
  );
}

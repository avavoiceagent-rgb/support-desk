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
import { usePolling } from "../hooks/usePolling";

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
      <Link to="/tickets" className="text-sm text-gray-500 hover:underline">
        ← Back to tickets
      </Link>

      <div className="mt-2 mb-4 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">{ticket.subject}</h1>
          <p className="mt-1 text-sm text-gray-500">
            #{ticket.ticketNumber} · {ticket.requesterName ? `${ticket.requesterName} · ` : ""}
            {ticket.requesterEmail}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={ticket.status} />
        </div>
      </div>

      <div className="mb-4 flex flex-wrap gap-4 rounded-lg border border-gray-200 bg-white p-3 text-sm">
        <label className="flex items-center gap-2">
          <span className="text-gray-500">Status</span>
          <StatusSelect value={ticket.status} onChange={handleStatusChange} />
        </label>
        <label className="flex items-center gap-2">
          <span className="text-gray-500">Assigned to</span>
          <AssigneeSelect users={users} value={ticket.assigneeId} onChange={handleAssigneeChange} />
        </label>
        <span className="ml-auto self-center text-gray-400">via {ticket.emailAccount.email}</span>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <ConversationTimeline ticketId={ticket.id} messages={ticket.messages} />
          <ReplyComposer ticketId={ticket.id} onSent={load} />
        </div>
        <div>
          <NotesPanel ticketId={ticket.id} notes={ticket.notes} onAdded={load} />
        </div>
      </div>
    </div>
  );
}

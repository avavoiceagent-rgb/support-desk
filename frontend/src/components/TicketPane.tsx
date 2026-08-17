import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import type { PublicUser, TicketDetail, TicketStatus } from "../api/types";
import { StatusBadge } from "./StatusBadge";
import { StatusSelect } from "./StatusSelect";
import { AssigneeSelect } from "./AssigneeSelect";
import { ConversationTimeline } from "./ConversationTimeline";
import { ReplyComposer } from "./ReplyComposer";
import { NotesPanel } from "./NotesPanel";
import { usePolling } from "../hooks/usePolling";

/**
 * Reading pane: shows a ticket's conversation and actions inline next to the
 * ticket list. All actions (status, assignee, reply, notes) work here too.
 */
export function TicketPane({
  ticketId,
  users,
  onClose,
  onChanged,
}: {
  ticketId: string;
  users: PublicUser[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [ticket, setTicket] = useState<TicketDetail | null>(null);
  const [tab, setTab] = useState<"conversation" | "notes">("conversation");
  const [error, setError] = useState(false);

  const load = useCallback(() => {
    api
      .get<{ ticket: TicketDetail }>(`/tickets/${ticketId}`)
      .then((r) => setTicket(r.ticket))
      .catch(() => setError(true));
  }, [ticketId]);

  // Reset + load whenever a different ticket is selected.
  useEffect(() => {
    setTicket(null);
    setError(false);
    setTab("conversation");
    load();
  }, [load]);

  usePolling(load, 20000);

  async function handleStatusChange(status: TicketStatus) {
    setTicket((t) => (t ? { ...t, status } : t));
    await api.patch(`/tickets/${ticketId}`, { status });
    load();
    onChanged();
  }

  async function handleAssigneeChange(assigneeId: string | null) {
    await api.patch(`/tickets/${ticketId}`, { assigneeId });
    load();
    onChanged();
  }

  function afterReplyOrNote() {
    load();
    onChanged();
  }

  return (
    <div className="sticky top-20 flex h-[calc(100vh-7rem)] flex-col overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-gray-100 px-4 py-3">
        {ticket ? (
          <>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="shrink-0 text-xs tabular-nums text-gray-400">#{ticket.ticketNumber}</span>
                <h2 className="truncate text-[15px] font-bold text-gray-900" title={ticket.subject}>
                  {ticket.subject}
                </h2>
              </div>
              <p className="mt-0.5 truncate text-xs text-gray-500">
                {ticket.requesterName ? `${ticket.requesterName} · ` : ""}
                {ticket.requesterEmail}
              </p>
            </div>
            <StatusBadge status={ticket.status} />
            <Link
              to={`/tickets/${ticket.id}`}
              title="Open full view"
              className="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-indigo-600"
            >
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 3h6v6" />
                <path d="M10 14 21 3" />
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              </svg>
            </Link>
            <button
              onClick={onClose}
              title="Close pane (Esc)"
              className="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700"
            >
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M18 6 6 18" />
                <path d="m6 6 12 12" />
              </svg>
            </button>
          </>
        ) : (
          <span className="text-sm text-gray-400">{error ? "Ticket not found." : "Loading…"}</span>
        )}
      </div>

      {ticket && (
        <>
          {/* Actions */}
          <div className="grid grid-cols-2 gap-2.5 border-b border-gray-100 bg-gray-50/60 px-4 py-3">
            <div>
              <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-gray-400">Status</p>
              <StatusSelect value={ticket.status} onChange={handleStatusChange} />
            </div>
            <div>
              <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-gray-400">Assigned to</p>
              <AssigneeSelect users={users} value={ticket.assigneeId} onChange={handleAssigneeChange} />
            </div>
          </div>

          {/* Tabs */}
          <div className="flex gap-1 border-b border-gray-100 px-3 pt-2">
            {(["conversation", "notes"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`rounded-t-lg px-3.5 py-2 text-sm font-medium transition-colors ${
                  tab === t
                    ? "border-b-2 border-indigo-600 text-indigo-700"
                    : "text-gray-500 hover:text-gray-800"
                }`}
              >
                {t === "conversation" ? "Conversation" : `Notes${ticket.notes.length ? ` (${ticket.notes.length})` : ""}`}
              </button>
            ))}
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto bg-gray-50/40 p-4">
            {tab === "conversation" ? (
              <div className="space-y-4">
                <ConversationTimeline ticketId={ticket.id} messages={ticket.messages} />
                <ReplyComposer ticketId={ticket.id} onSent={afterReplyOrNote} />
              </div>
            ) : (
              <NotesPanel ticketId={ticket.id} notes={ticket.notes} onAdded={afterReplyOrNote} />
            )}
          </div>
        </>
      )}
    </div>
  );
}

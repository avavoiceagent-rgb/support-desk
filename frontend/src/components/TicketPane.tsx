import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import type {
  PublicUser,
  ReservationSource,
  ReservationType,
  TicketChannel,
  TicketDetail,
  TicketQueue,
  TicketStatus,
} from "../api/types";
import { CHANNELS, QUEUES } from "../lib/statuses";
import { AutoBadge, ReservationLabels, TriageReason } from "./TriageBlock";
import { StatusBadge } from "./StatusBadge";
import { StatusSelect } from "./StatusSelect";
import { AssigneeSelect } from "./AssigneeSelect";
import { ConversationTimeline } from "./ConversationTimeline";
import { Composer } from "./Composer";
import { useDraft } from "../hooks/useDraft";
import { useOpsContext } from "../hooks/useOpsContext";
import { OpsContextPanel } from "./OpsContextPanel";
import { ReservationPanel } from "./ReservationPanel";
import { HistoryDrawer } from "./HistoryDrawer";
import { usePolling } from "../hooks/usePolling";

/**
 * Reading pane: shows a ticket's conversation and actions inline next to the
 * ticket list. Emails and internal notes share one timeline; the composer
 * below switches between replying to the customer and adding a note.
 */
export function TicketPane({
  ticketId,
  users,
  onClose,
  onChanged,
  onOpenTicket,
}: {
  ticketId: string;
  users: PublicUser[];
  onClose: () => void;
  onChanged: () => void;
  onOpenTicket?: (id: string) => void;
}) {
  const [ticket, setTicket] = useState<TicketDetail | null>(null);
  const [seedBody, setSeedBody] = useState("");
  const [seedKey, setSeedKey] = useState(0);
  const { draft, markUsed, markDismissed } = useDraft(ticketId);
  const { context: opsContext } = useOpsContext(ticketId);
  const [error, setError] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

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
    setHistoryOpen(false);
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

  async function handleQueueChange(queue: TicketQueue | null) {
    // Leaving the reservation queue makes the reservation sub-labels
    // meaningless, so clear them in the same edit.
    const clearSub = queue !== "RESERVATION";
    setTicket((t) =>
      t
        ? {
            ...t,
            queue,
            autoClassified: false,
            ...(clearSub ? { reservationType: null, reservationSource: null } : {}),
          }
        : t
    );
    // The server clears the sub-labels itself when the queue leaves
    // Reservation; this only keeps the on-screen copy honest until the reload.
    await api.patch(`/tickets/${ticketId}`, { queue });
    load();
    onChanged();
  }

  async function handleReservationTypeChange(reservationType: ReservationType | null) {
    setTicket((t) => (t ? { ...t, reservationType, autoClassified: false } : t));
    await api.patch(`/tickets/${ticketId}`, { reservationType });
    load();
    onChanged();
  }

  async function handleReservationSourceChange(reservationSource: ReservationSource | null) {
    setTicket((t) => (t ? { ...t, reservationSource, autoClassified: false } : t));
    await api.patch(`/tickets/${ticketId}`, { reservationSource });
    load();
    onChanged();
  }

  async function handleChannelChange(channel: TicketChannel) {
    setTicket((t) => (t ? { ...t, channel } : t));
    await api.patch(`/tickets/${ticketId}`, { channel });
    load();
    onChanged();
  }

  function afterSend() {
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
                {ticket.requesterEmail ?? ticket.requesterPhone ?? ""}
              </p>
            </div>
            <StatusBadge status={ticket.status} />
            <button
              onClick={() => setHistoryOpen(true)}
              title="Previous tickets from this sender"
              className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium text-gray-500 transition-colors hover:bg-gray-100 hover:text-indigo-600"
            >
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
                <path d="M12 7v5l4 2" />
              </svg>
              History
            </button>
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
          {/* Actions — status itself is changed down in the composer */}
          <div className="grid grid-cols-3 gap-2.5 border-b border-gray-100 bg-gray-50/60 px-4 py-3">
            <div className="min-w-0">
              <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-gray-400">Assigned to</p>
              <AssigneeSelect users={users} value={ticket.assigneeId} onChange={handleAssigneeChange} />
            </div>
            <div className="min-w-0">
              <p className="mb-1 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-gray-400">
                Queue
                <AutoBadge ticket={ticket} />
              </p>
              <select
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                value={ticket.queue ?? ""}
                onChange={(e) => void handleQueueChange((e.target.value || null) as TicketQueue | null)}
              >
                <option value="">No queue</option>
                {QUEUES.map((q) => (
                  <option key={q.value} value={q.value}>
                    {q.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="min-w-0">
              <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-gray-400">Channel</p>
              <select
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                value={ticket.channel}
                onChange={(e) => void handleChannelChange(e.target.value as TicketChannel)}
              >
                {CHANNELS.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {ticket.queue === "RESERVATION" && (
            <div className="grid grid-cols-2 gap-2.5 border-b border-gray-100 bg-gray-50/60 px-4 pb-3">
              <ReservationLabels
                ticket={ticket}
                onTypeChange={(v) => void handleReservationTypeChange(v)}
                onSourceChange={(v) => void handleReservationSourceChange(v)}
              />
            </div>
          )}

          <TriageReason ticket={ticket} className="border-b border-gray-100" />

          {/* Here as well as on the standalone ticket page: this split view is
              where the work actually happens, and a button that only exists on
              a page nobody opens is not a feature. */}
          <div className="border-b border-gray-100 px-4 pb-3">
            <ReservationPanel
              ticketId={ticketId}
              onTicketChanged={load}
              // The same door as the detail page. Without it this view has no
              // Confirmation email link at all, which is a second way for the
              // same feature to look like it does not exist.
              onDraftReply={(bodyHtml) => {
                setSeedBody(bodyHtml);
                setSeedKey((k) => k + 1);
              }}
            />
          </div>

          <OpsContextPanel context={opsContext} />

          {/* Conversation (emails + notes) and composer */}
          <div className="flex-1 overflow-y-auto bg-gray-50/40 p-4">
            <div className="space-y-4">
              <ConversationTimeline
                ticketId={ticket.id}
                messages={ticket.messages}
                notes={ticket.notes}
                dispatch={ticket.dispatch}
                tripEvents={ticket.tripEvents}
                draft={draft}
                onUseDraft={(text) => {
                  setSeedBody(text);
                  setSeedKey((k) => k + 1);
                  void markUsed();
                }}
                onDismissDraft={() => void markDismissed()}
              />
              <Composer
                ticketId={ticket.id}
                onSent={afterSend}
                seedBody={seedBody}
                seedKey={seedKey}
                statusSlot={<StatusSelect compact value={ticket.status} onChange={handleStatusChange} />}
              />
            </div>
          </div>

          {historyOpen && (
            <HistoryDrawer
              ticketId={ticket.id}
              requesterLabel={ticket.requesterName ?? ticket.requesterEmail ?? ticket.requesterPhone ?? "Unknown"}
              onClose={() => setHistoryOpen(false)}
              onSelect={(id) => {
                setHistoryOpen(false);
                if (onOpenTicket) onOpenTicket(id);
              }}
            />
          )}
        </>
      )}
    </div>
  );
}

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api/client";
import type { TicketHistoryItem } from "../api/types";
import { StatusBadge } from "./StatusBadge";
import { Avatar } from "./Avatar";
import { timeAgo } from "../lib/ui";

/**
 * Right-hand sidebar listing previous tickets from the same sender (matched
 * by email address or display name). Clicking one opens it.
 */
export function HistoryDrawer({
  ticketId,
  requesterLabel,
  onSelect,
  onClose,
}: {
  ticketId: string;
  requesterLabel: string;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const [items, setItems] = useState<TicketHistoryItem[] | null>(null);

  useEffect(() => {
    setItems(null);
    api
      .get<{ history: TicketHistoryItem[] }>(`/tickets/${ticketId}/history`)
      .then((r) => setItems(r.history))
      .catch(() => setItems([]));
  }, [ticketId]);

  // Esc closes the drawer (and only the drawer — capture phase runs first).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  // Portal to <body>: the pane is a sticky container, which would otherwise
  // trap the drawer's z-index beneath the app header.
  return createPortal(
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-40 bg-gray-900/20" onClick={onClose} />

      {/* Sidebar */}
      <div className="fixed inset-y-0 right-0 z-50 flex w-[400px] max-w-[92vw] flex-col border-l border-gray-200 bg-white shadow-2xl">
        <div className="flex items-center gap-3 border-b border-gray-100 px-4 py-3">
          <Avatar name={requesterLabel} size={8} />
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-bold text-gray-900">Sender history</h2>
            <p className="truncate text-xs text-gray-500">{requesterLabel}</p>
          </div>
          <button
            onClick={onClose}
            title="Close (Esc)"
            className="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {items === null ? (
            <p className="p-6 text-center text-sm text-gray-500">Loading…</p>
          ) : items.length === 0 ? (
            <div className="p-8 text-center">
              <p className="text-sm font-medium text-gray-900">No other tickets</p>
              <p className="mt-1 text-sm text-gray-500">This is the only ticket from this sender.</p>
            </div>
          ) : (
            <ul className="divide-y divide-gray-100">
              {items.map((t) => (
                <li key={t.id}>
                  <button
                    onClick={() => onSelect(t.id)}
                    className="w-full px-4 py-3 text-left transition-colors hover:bg-indigo-50/50"
                  >
                    <div className="flex items-center gap-2">
                      <span className="shrink-0 text-xs tabular-nums text-gray-400">#{t.ticketNumber}</span>
                      <span className="min-w-0 flex-1 truncate text-sm font-semibold text-gray-900">{t.subject}</span>
                    </div>
                    <div className="mt-1 flex items-center gap-2">
                      <StatusBadge status={t.status} />
                      <span className="text-[11px] text-gray-400">{timeAgo(t.updatedAt)}</span>
                    </div>
                    {t.snippet && <p className="mt-1 truncate text-[13px] text-gray-500">{t.snippet}</p>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </>,
    document.body
  );
}

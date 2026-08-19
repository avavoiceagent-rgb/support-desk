// The AI triage controls: the two reservation sub-labels and the explanation
// of what the machine decided.
//
// Shared by the reading pane and the full-page ticket view so the two can't
// drift apart — an agent must be able to see and correct the labels wherever
// they happen to be working.

import type { ReservationSource, ReservationType, TicketQueue } from "../api/types";
import { RESERVATION_SOURCES, RESERVATION_TYPES } from "../lib/statuses";

export interface TriageState {
  queue: TicketQueue | null;
  reservationType: ReservationType | null;
  reservationSource: ReservationSource | null;
  autoClassified: boolean;
  classificationReason: string | null;
  classificationConfidence: string | null;
}

const selectClass =
  "w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20";

/** Small "set by the machine" marker, shown beside the Queue label. */
export function AutoBadge({ ticket }: { ticket: TriageState }) {
  if (!ticket.autoClassified) return null;
  return (
    <span
      title={ticket.classificationReason ?? "Sorted automatically when the email arrived."}
      className="cursor-help rounded-full bg-violet-50 px-1.5 py-0.5 text-[9px] font-semibold tracking-wide text-violet-600"
    >
      AUTO
    </span>
  );
}

export function ReservationLabels({
  ticket,
  onTypeChange,
  onSourceChange,
}: {
  ticket: TriageState;
  onTypeChange: (v: ReservationType | null) => void;
  onSourceChange: (v: ReservationSource | null) => void;
}) {
  if (ticket.queue !== "RESERVATION") return null;
  return (
    <>
      <div className="min-w-0">
        <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-gray-400">Reservation</p>
        <select
          className={selectClass}
          value={ticket.reservationType ?? ""}
          onChange={(e) => onTypeChange((e.target.value || null) as ReservationType | null)}
        >
          <option value="">Not set</option>
          {RESERVATION_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </div>
      <div className="min-w-0">
        <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-gray-400">Run by</p>
        <select
          className={selectClass}
          value={ticket.reservationSource ?? ""}
          onChange={(e) => onSourceChange((e.target.value || null) as ReservationSource | null)}
        >
          <option value="">Not set</option>
          {RESERVATION_SOURCES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </div>
    </>
  );
}

/**
 * Why the machine chose what it chose. Low-confidence decisions say so, so
 * nobody treats a guess as a fact.
 */
export function TriageReason({ ticket, className = "" }: { ticket: TriageState; className?: string }) {
  if (!ticket.autoClassified || !ticket.classificationReason) return null;
  const unsure = ticket.classificationConfidence === "low";
  return (
    <p className={`bg-violet-50/40 px-4 py-2 text-[12px] text-violet-900/70 ${className}`}>
      <span className="font-semibold">Sorted automatically:</span> {ticket.classificationReason}
      {unsure && <span className="ml-1 font-medium text-amber-700">(low confidence — worth a check)</span>}
    </p>
  );
}

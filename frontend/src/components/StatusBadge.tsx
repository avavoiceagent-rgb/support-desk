import type { TicketStatus } from "../api/types";

const STYLES: Record<TicketStatus, string> = {
  OPEN: "bg-emerald-100 text-emerald-800",
  IN_PROGRESS: "bg-amber-100 text-amber-800",
  CLOSED: "bg-gray-200 text-gray-700",
};

const LABELS: Record<TicketStatus, string> = {
  OPEN: "Open",
  IN_PROGRESS: "In Progress",
  CLOSED: "Closed",
};

export function StatusBadge({ status }: { status: TicketStatus }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${STYLES[status]}`}>
      {LABELS[status]}
    </span>
  );
}

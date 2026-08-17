import type { TicketStatus } from "../api/types";

const STYLES: Record<TicketStatus, { pill: string; dot: string; label: string }> = {
  OPEN: { pill: "bg-emerald-50 text-emerald-700 ring-emerald-600/20", dot: "bg-emerald-500", label: "Open" },
  IN_PROGRESS: { pill: "bg-amber-50 text-amber-700 ring-amber-600/20", dot: "bg-amber-500", label: "In Progress" },
  CLOSED: { pill: "bg-gray-100 text-gray-600 ring-gray-500/20", dot: "bg-gray-400", label: "Closed" },
};

export function StatusBadge({ status }: { status: TicketStatus }) {
  const s = STYLES[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${s.pill}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}

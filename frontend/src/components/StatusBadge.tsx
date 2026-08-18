import type { TicketStatus } from "../api/types";
import { statusMeta } from "../lib/statuses";

export function StatusBadge({ status }: { status: TicketStatus }) {
  const s = statusMeta(status);
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-medium ${s.badge}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}

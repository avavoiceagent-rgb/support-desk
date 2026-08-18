import type { TicketStatus } from "../api/types";
import { GROUP_LABELS, STATUSES } from "../lib/statuses";

const GROUPS = ["ACTIVE", "WAITING", "CLOSED"] as const;

export function StatusSelect({
  value,
  onChange,
  disabled,
  compact,
}: {
  value: TicketStatus;
  onChange: (status: TicketStatus) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  return (
    <select
      className={`rounded-lg border border-gray-300 bg-white text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 disabled:opacity-50 ${
        compact ? "px-2 py-1.5" : "w-full px-3 py-2"
      }`}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as TicketStatus)}
    >
      {GROUPS.map((g) => (
        <optgroup key={g} label={GROUP_LABELS[g]}>
          {STATUSES.filter((s) => s.group === g).map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

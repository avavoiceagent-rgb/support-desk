import type { TicketStatus } from "../api/types";

const OPTIONS: { value: TicketStatus; label: string }[] = [
  { value: "OPEN", label: "Open" },
  { value: "IN_PROGRESS", label: "In Progress" },
  { value: "CLOSED", label: "Closed" },
];

export function StatusSelect({
  value,
  onChange,
  disabled,
}: {
  value: TicketStatus;
  onChange: (status: TicketStatus) => void;
  disabled?: boolean;
}) {
  return (
    <select
      className="rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm disabled:opacity-50"
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as TicketStatus)}
    >
      {OPTIONS.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}

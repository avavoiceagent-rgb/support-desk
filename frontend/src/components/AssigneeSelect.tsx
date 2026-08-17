import type { PublicUser } from "../api/types";

export function AssigneeSelect({
  users,
  value,
  onChange,
  disabled,
}: {
  users: PublicUser[];
  value: string | null;
  onChange: (userId: string | null) => void;
  disabled?: boolean;
}) {
  return (
    <select
      className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 disabled:opacity-50"
      value={value ?? ""}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value || null)}
    >
      <option value="">Unassigned</option>
      {users.map((u) => (
        <option key={u.id} value={u.id}>
          {u.name}
        </option>
      ))}
    </select>
  );
}

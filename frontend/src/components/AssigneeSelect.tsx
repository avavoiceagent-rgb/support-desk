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
      className="rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm disabled:opacity-50"
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

import { useEffect, useState } from "react";
import type { PublicUser } from "../api/types";

/**
 * Assignee picker with an explicit confirm step: picking a name in the
 * dropdown does nothing until the "Assign" button is clicked. Re-selecting
 * the current assignee (or pressing the ✕) cancels the pending change.
 */
export function AssigneeSelect({
  users,
  value,
  onChange,
  disabled,
}: {
  users: PublicUser[];
  value: string | null;
  onChange: (userId: string | null) => void | Promise<void>;
  disabled?: boolean;
}) {
  const [pending, setPending] = useState<string | null>(value);
  const [saving, setSaving] = useState(false);

  // Follow outside changes (polling refresh, switching tickets).
  useEffect(() => {
    setPending(value);
  }, [value]);

  const dirty = pending !== value;

  async function confirm() {
    setSaving(true);
    try {
      await onChange(pending);
    } finally {
      setSaving(false);
    }
  }

  const pendingName = pending ? users.find((u) => u.id === pending)?.name : null;

  return (
    <div>
      <select
        className={`w-full rounded-lg border bg-white px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 disabled:opacity-50 ${
          dirty
            ? "border-indigo-400 ring-2 ring-indigo-500/20"
            : "border-gray-300 focus:border-indigo-500 focus:ring-indigo-500/20"
        }`}
        value={pending ?? ""}
        disabled={disabled || saving}
        onChange={(e) => setPending(e.target.value || null)}
      >
        <option value="">Unassigned</option>
        {users.map((u) => (
          <option key={u.id} value={u.id}>
            {u.name}
          </option>
        ))}
      </select>
      {dirty && (
        // Confirm controls on their own line so they can never be squeezed
        // out of view in narrow layouts.
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <button
            onClick={() => void confirm()}
            disabled={saving}
            className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-700 disabled:opacity-50"
          >
            {saving
              ? "Assigning…"
              : pendingName
                ? `Assign to ${pendingName.split(" ")[0]}`
                : "Remove assignee"}
          </button>
          <button
            onClick={() => setPending(value)}
            disabled={saving}
            className="text-sm text-gray-500 hover:underline disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

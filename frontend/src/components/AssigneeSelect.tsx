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

  return (
    <div className="flex items-center gap-1.5">
      <select
        className="w-full min-w-0 flex-1 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 disabled:opacity-50"
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
        <>
          <button
            onClick={() => void confirm()}
            disabled={saving}
            className="shrink-0 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-700 disabled:opacity-50"
          >
            {saving ? "Assigning…" : "Assign"}
          </button>
          <button
            onClick={() => setPending(value)}
            disabled={saving}
            title="Cancel"
            className="shrink-0 rounded-lg p-2 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 disabled:opacity-50"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </>
      )}
    </div>
  );
}

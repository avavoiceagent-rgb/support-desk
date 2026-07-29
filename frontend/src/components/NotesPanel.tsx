import { useState } from "react";
import { api } from "../api/client";
import type { TicketNote } from "../api/types";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function NotesPanel({ ticketId, notes, onAdded }: { ticketId: string; notes: TicketNote[]; onAdded: () => void }) {
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleAdd() {
    if (!body.trim()) return;
    setSaving(true);
    try {
      await api.post(`/tickets/${ticketId}/notes`, { body });
      setBody("");
      onAdded();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
      <h3 className="mb-2 text-sm font-medium text-amber-900">Internal notes (not visible to the customer)</h3>
      <div className="mb-3 space-y-2">
        {notes.length === 0 && <p className="text-sm text-amber-700">No notes yet.</p>}
        {notes.map((n) => (
          <div key={n.id} className="rounded-md bg-white p-2 text-sm">
            <div className="mb-1 flex justify-between text-xs text-gray-500">
              <span className="font-medium text-gray-700">{n.author.name}</span>
              <span>{formatDate(n.createdAt)}</span>
            </div>
            <p className="whitespace-pre-wrap text-gray-800">{n.body}</p>
          </div>
        ))}
      </div>
      <textarea
        className="w-full rounded-md border border-amber-300 p-2 text-sm focus:border-amber-500 focus:outline-none"
        rows={2}
        placeholder="Add a note for the team…"
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <div className="mt-2 flex justify-end">
        <button
          onClick={() => void handleAdd()}
          disabled={saving || !body.trim()}
          className="rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Add note"}
        </button>
      </div>
    </div>
  );
}

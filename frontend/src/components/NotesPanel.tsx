import { useState } from "react";
import { api } from "../api/client";
import type { TicketNote } from "../api/types";
import { Avatar } from "./Avatar";
import { formatDateTime } from "../lib/ui";

export function NotesPanel({ ticketId, notes, onAdded }: { ticketId: string; notes: TicketNote[]; onAdded: () => void }) {
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleAdd() {
    if (!body.trim() || saving) return;
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
    <div className="overflow-hidden rounded-xl border border-amber-200/80 bg-amber-50/70 shadow-sm">
      <div className="flex items-center gap-2 border-b border-amber-200/60 px-4 py-2.5">
        <svg className="h-4 w-4 text-amber-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M15.5 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8.5L15.5 3Z" />
          <path d="M15 3v6h6" />
        </svg>
        <h3 className="text-sm font-semibold text-amber-900">Internal notes</h3>
        <span className="ml-auto text-[11px] text-amber-600">not visible to customer</span>
      </div>
      <div className="space-y-2.5 p-4">
        {notes.length === 0 && <p className="text-sm text-amber-700/80">No notes yet.</p>}
        {notes.map((n) => (
          <div key={n.id} className="rounded-lg border border-amber-100 bg-white p-3 shadow-sm">
            <div className="mb-1.5 flex items-center gap-2">
              <Avatar name={n.author.name} size={6} />
              <span className="text-xs font-semibold text-gray-800">{n.author.name}</span>
              <span className="ml-auto text-[11px] text-gray-400">{formatDateTime(n.createdAt)}</span>
            </div>
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-gray-700">{n.body}</p>
          </div>
        ))}
        <textarea
          className="w-full resize-y rounded-lg border border-amber-300/70 bg-white p-2.5 text-sm placeholder:text-amber-700/40 focus:border-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-500/20"
          rows={2}
          placeholder="Add a note for the team…"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") void handleAdd();
          }}
        />
        <div className="flex justify-end">
          <button
            onClick={() => void handleAdd()}
            disabled={saving || !body.trim()}
            className="rounded-lg bg-amber-500 px-3 py-1.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-amber-600 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Add note"}
          </button>
        </div>
      </div>
    </div>
  );
}

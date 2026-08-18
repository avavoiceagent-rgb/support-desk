import { useState } from "react";
import { api, ApiError } from "../api/client";

type Mode = "reply" | "note";

/**
 * One comment box with a choice: send a reply email to the customer, or add
 * an internal note only the team can see. Note mode turns the box amber so
 * it's always obvious which one is about to happen.
 */
export function Composer({ ticketId, onSent }: { ticketId: string; onSent: () => void }) {
  const [mode, setMode] = useState<Mode>("reply");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isNote = mode === "note";

  async function handleSubmit() {
    if (!body.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      if (isNote) {
        await api.post(`/tickets/${ticketId}/notes`, { body });
      } else {
        const bodyHtml = body
          .split("\n")
          .map((line) => `<p>${line || "&nbsp;"}</p>`)
          .join("");
        await api.post(`/tickets/${ticketId}/reply`, { bodyHtml });
      }
      setBody("");
      onSent();
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : isNote ? "Failed to add note." : "Failed to send reply."
      );
    } finally {
      setSending(false);
    }
  }

  const tabClass = (active: boolean, note: boolean) =>
    `rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
      active
        ? note
          ? "bg-amber-100 text-amber-900"
          : "bg-indigo-100 text-indigo-800"
        : "text-gray-500 hover:text-gray-800"
    }`;

  return (
    <div
      className={`overflow-hidden rounded-xl border shadow-sm ${
        isNote ? "border-amber-200/80 bg-amber-50/70" : "border-gray-200 bg-white"
      }`}
    >
      <div
        className={`flex items-center gap-1 border-b px-3 py-2 ${
          isNote ? "border-amber-200/60" : "border-gray-100"
        }`}
      >
        <button onClick={() => setMode("reply")} className={tabClass(!isNote, false)}>
          Reply to customer
        </button>
        <button onClick={() => setMode("note")} className={tabClass(isNote, true)}>
          Internal note
        </button>
        {isNote && <span className="ml-auto text-[11px] text-amber-600">not visible to customer</span>}
      </div>
      <div className="p-4">
        <textarea
          className={`w-full resize-y rounded-lg border p-3 text-sm focus:outline-none focus:ring-2 ${
            isNote
              ? "border-amber-300/70 bg-white placeholder:text-amber-700/40 focus:border-amber-500 focus:ring-amber-500/20"
              : "border-gray-300 placeholder:text-gray-400 focus:border-indigo-500 focus:ring-indigo-500/20"
          }`}
          rows={4}
          placeholder={
            isNote ? "Add a note for the team — the customer won't see it…" : "Type your reply — it will be sent as an email…"
          }
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") void handleSubmit();
          }}
        />
        {error && <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        <div className="mt-3 flex items-center justify-between">
          <span className={`text-xs ${isNote ? "text-amber-600/80" : "text-gray-400"}`}>Ctrl+Enter to send</span>
          <button
            onClick={() => void handleSubmit()}
            disabled={sending || !body.trim()}
            className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors disabled:opacity-50 ${
              isNote ? "bg-amber-500 hover:bg-amber-600" : "bg-indigo-600 hover:bg-indigo-700"
            }`}
          >
            {sending ? (
              isNote ? "Saving…" : "Sending…"
            ) : isNote ? (
              <>
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M15.5 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8.5L15.5 3Z" />
                  <path d="M15 3v6h6" />
                </svg>
                Add note
              </>
            ) : (
              <>
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m22 2-7 20-4-9-9-4Z" />
                  <path d="M22 2 11 13" />
                </svg>
                Send reply
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

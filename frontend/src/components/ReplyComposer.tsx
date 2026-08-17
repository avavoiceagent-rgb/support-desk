import { useState } from "react";
import { api, ApiError } from "../api/client";

export function ReplyComposer({ ticketId, onSent }: { ticketId: string; onSent: () => void }) {
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSend() {
    if (!body.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      const bodyHtml = body
        .split("\n")
        .map((line) => `<p>${line || "&nbsp;"}</p>`)
        .join("");
      await api.post(`/tickets/${ticketId}/reply`, { bodyHtml });
      setBody("");
      onSent();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to send reply.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
      <div className="border-b border-gray-100 px-4 py-2.5">
        <h3 className="text-sm font-semibold text-gray-900">Reply to customer</h3>
      </div>
      <div className="p-4">
        <textarea
          className="w-full resize-y rounded-lg border border-gray-300 p-3 text-sm placeholder:text-gray-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
          rows={4}
          placeholder="Type your reply — it will be sent as an email…"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") void handleSend();
          }}
        />
        {error && (
          <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
        )}
        <div className="mt-3 flex items-center justify-between">
          <span className="text-xs text-gray-400">Ctrl+Enter to send</span>
          <button
            onClick={() => void handleSend()}
            disabled={sending || !body.trim()}
            className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-700 disabled:opacity-50"
          >
            {sending ? (
              "Sending…"
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

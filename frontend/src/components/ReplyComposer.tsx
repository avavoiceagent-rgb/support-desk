import { useState } from "react";
import { api, ApiError } from "../api/client";

export function ReplyComposer({ ticketId, onSent }: { ticketId: string; onSent: () => void }) {
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSend() {
    if (!body.trim()) return;
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
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <h3 className="mb-2 text-sm font-medium text-gray-700">Reply to customer</h3>
      <textarea
        className="w-full rounded-md border border-gray-300 p-2 text-sm focus:border-gray-500 focus:outline-none"
        rows={4}
        placeholder="Type your reply — this will be sent as an email…"
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      <div className="mt-2 flex justify-end">
        <button
          onClick={() => void handleSend()}
          disabled={sending || !body.trim()}
          className="rounded-md bg-gray-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
        >
          {sending ? "Sending…" : "Send reply"}
        </button>
      </div>
    </div>
  );
}

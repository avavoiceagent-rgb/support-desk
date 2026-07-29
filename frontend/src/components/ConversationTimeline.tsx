import type { TicketMessage } from "../api/types";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function ConversationTimeline({ ticketId, messages }: { ticketId: string; messages: TicketMessage[] }) {
  if (messages.length === 0) {
    return <div className="p-6 text-center text-sm text-gray-500">No messages yet.</div>;
  }

  return (
    <div className="space-y-4">
      {messages.map((m) => (
        <div
          key={m.id}
          className={`rounded-lg border p-4 ${
            m.direction === "OUTBOUND" ? "border-blue-100 bg-blue-50" : "border-gray-200 bg-white"
          }`}
        >
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2 text-xs text-gray-500">
            <div>
              <span className="font-medium text-gray-800">
                {m.direction === "OUTBOUND" ? m.author?.name ?? "Support" : m.fromAddress}
              </span>
              {m.direction === "OUTBOUND" && <span className="ml-1 text-gray-400">replied</span>}
              {m.isAutoReply && (
                <span className="ml-2 rounded bg-gray-200 px-1.5 py-0.5 text-[10px] uppercase text-gray-600">
                  Auto-reply
                </span>
              )}
            </div>
            <span>{formatDate(m.sentAt)}</span>
          </div>
          <div className="prose prose-sm max-w-none text-gray-800" dangerouslySetInnerHTML={{ __html: m.bodyHtml }} />
          {m.attachments.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {m.attachments.map((a) => (
                <a
                  key={a.id}
                  href={`/api/tickets/${ticketId}/attachments/${a.id}`}
                  className="rounded border border-gray-300 bg-white px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
                  download={a.filename}
                >
                  📎 {a.filename}
                </a>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

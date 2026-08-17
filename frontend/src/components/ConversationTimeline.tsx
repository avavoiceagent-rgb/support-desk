import type { TicketMessage } from "../api/types";
import { Avatar } from "./Avatar";
import { displayName, formatDateTime } from "../lib/ui";

export function ConversationTimeline({ ticketId, messages }: { ticketId: string; messages: TicketMessage[] }) {
  if (messages.length === 0) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white p-8 text-center text-sm text-gray-500">
        No messages yet.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {messages.map((m) => {
        const outbound = m.direction === "OUTBOUND";
        const who = outbound ? m.author?.name ?? "Support" : displayName(m.fromAddress);
        return (
          <div key={m.id} className="flex gap-3">
            <Avatar name={who} size={9} />
            <div
              className={`min-w-0 flex-1 overflow-hidden rounded-xl border shadow-sm ${
                outbound ? "border-indigo-100 bg-indigo-50/60" : "border-gray-200 bg-white"
              }`}
            >
              <div
                className={`flex flex-wrap items-baseline justify-between gap-2 border-b px-4 py-2 ${
                  outbound ? "border-indigo-100/80" : "border-gray-100"
                }`}
              >
                <div className="flex items-center gap-2 text-sm">
                  <span className="font-semibold text-gray-900">{who}</span>
                  {outbound && (
                    <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-[11px] font-medium text-indigo-700">
                      Reply sent
                    </span>
                  )}
                  {m.isAutoReply && (
                    <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-gray-500">
                      Auto-reply
                    </span>
                  )}
                </div>
                <span className="text-xs text-gray-400">{formatDateTime(m.sentAt)}</span>
              </div>
              <div
                className="prose prose-sm max-w-none break-words px-4 py-3 text-[14px] leading-relaxed text-gray-800"
                dangerouslySetInnerHTML={{ __html: m.bodyHtml }}
              />
              {m.attachments.length > 0 && (
                <div className="flex flex-wrap gap-2 border-t border-gray-100 px-4 py-2.5">
                  {m.attachments.map((a) => (
                    <a
                      key={a.id}
                      href={`/api/tickets/${ticketId}/attachments/${a.id}`}
                      download={a.filename}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 shadow-sm transition-colors hover:border-indigo-300 hover:text-indigo-700"
                    >
                      <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                      </svg>
                      {a.filename}
                    </a>
                  ))}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// A drafted reply, shown in the ticket's timeline where it happened.
//
// Deliberately NOT styled like an internal note. A note is something a
// colleague wrote and stands behind; this is a machine's suggestion that
// nobody has checked yet, and the two must never be mistaken for each other at
// a glance. Hence the violet frame, the robot mark instead of a person's
// initials, and "Not sent" stated on the face of it.
//
// It stays in the timeline permanently. Using or dismissing it changes the
// label, not whether you can see it.

export interface RateSource {
  title: string;
  url: string;
}

export interface DraftRate {
  low: number;
  high: number;
  currency: string;
  basis: string;
  sources: RateSource[];
}

export interface TicketDraft {
  id: string;
  bodyHtml: string;
  confirmations: string[];
  questions: string[];
  internalNotes: string[];
  rate: DraftRate | null;
  status: "READY" | "USED" | "DISMISSED" | string;
  createdAt: string;
}

/**
 * The composer edits plain text and wraps it in paragraphs on send, so bring
 * the draft down to text rather than pushing HTML through it twice.
 */
export function draftToPlainText(html: string): string {
  return html
    .replace(/<li[^>]*>/gi, "\n• ")
    .replace(/<\/(?:p|div|ul|ol|h[1-6])>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

function StatusChip({ status }: { status: string }) {
  if (status === "USED") {
    return (
      <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-medium text-violet-700">
        Used
      </span>
    );
  }
  if (status === "DISMISSED") {
    return (
      <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-500">
        Set aside
      </span>
    );
  }
  return null;
}

export function DraftCard({
  draft,
  at,
  onUse,
  onDismiss,
}: {
  draft: TicketDraft;
  at: string;
  onUse: (text: string) => void;
  onDismiss: () => void;
}) {
  return (
    <div className="flex gap-3">
      {/* A mark, not a person's initials — this was not written by a colleague. */}
      <span
        title="Drafted automatically"
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-violet-100 text-violet-600"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="4" y="8" width="16" height="12" rx="2" />
          <path d="M12 8V4M9 14h.01M15 14h.01" />
        </svg>
      </span>

      <div className="min-w-0 flex-1 overflow-hidden rounded-xl border border-violet-200/80 bg-violet-50/60 shadow-sm">
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-violet-200/60 px-4 py-2">
          <div className="flex items-center gap-2 text-sm">
            <span className="font-semibold text-gray-900">Suggested reply</span>
            <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-medium text-violet-700">
              Not sent
            </span>
            <StatusChip status={draft.status} />
          </div>
          <span className="text-xs text-gray-400">{at}</span>
        </div>

        {draft.internalNotes.length > 0 && (
          <ul className="mx-4 mt-3 space-y-1 rounded-lg bg-amber-50 px-3 py-2 text-[12px] text-amber-900">
            {draft.internalNotes.map((note, i) => (
              <li key={i}>⚠ {note}</li>
            ))}
          </ul>
        )}

        <div
          className="px-4 py-3 text-[14px] leading-relaxed text-gray-800 [&_li]:ml-4 [&_li]:list-disc [&_p]:mb-2"
          dangerouslySetInnerHTML={{ __html: draft.bodyHtml }}
        />

        {draft.rate && (
          <p className="mx-4 mb-3 border-t border-violet-200/50 pt-2 text-[11px] text-gray-500">
            Market rate {draft.rate.currency} {draft.rate.low}–{draft.rate.high} ({draft.rate.basis}) — from{" "}
            {draft.rate.sources.map((s, i) => (
              <span key={s.url}>
                {i > 0 && ", "}
                <a href={s.url} target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline">
                  {s.title}
                </a>
              </span>
            ))}
            . Not a quote — check it before repeating it.
          </p>
        )}

        <div className="flex items-center gap-2 border-t border-violet-200/50 px-4 py-2.5">
          <button
            onClick={() => onUse(draftToPlainText(draft.bodyHtml))}
            className="rounded-lg bg-violet-600 px-3.5 py-1.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-violet-700"
          >
            {draft.status === "USED" ? "Load into the reply box again" : "Use this draft"}
          </button>
          {draft.status !== "DISMISSED" && (
            <button
              onClick={onDismiss}
              className="rounded-lg px-3 py-1.5 text-sm text-gray-500 transition-colors hover:bg-gray-100"
            >
              Set aside
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

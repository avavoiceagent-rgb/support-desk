// The suggested reply, offered for review above the composer.
//
// Deliberately not auto-filled into the box: an agent should decide to use it,
// not discover their reply already written. The warnings sit above the draft
// because they are the things a person needs to catch before sending.

import { useEffect, useState } from "react";
import { api } from "../api/client";

interface RateSource {
  title: string;
  url: string;
}

interface Rate {
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
  rate: Rate | null;
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

export function DraftPanel({
  ticketId,
  onUse,
}: {
  ticketId: string;
  onUse: (text: string) => void;
}) {
  const [draft, setDraft] = useState<TicketDraft | null>(null);
  const [open, setOpen] = useState(false);
  const [gone, setGone] = useState(false);

  useEffect(() => {
    setDraft(null);
    setOpen(false);
    setGone(false);
    api
      .get<{ draft: TicketDraft | null }>(`/tickets/${ticketId}/draft`)
      .then((r) => setDraft(r.draft))
      .catch(() => setDraft(null));
  }, [ticketId]);

  if (!draft || gone) return null;

  async function use() {
    if (!draft) return;
    onUse(draftToPlainText(draft.bodyHtml));
    setGone(true);
    await api.post(`/tickets/${ticketId}/draft/use`).catch(() => {});
  }

  async function dismiss() {
    setGone(true);
    await api.post(`/tickets/${ticketId}/draft/dismiss`).catch(() => {});
  }

  return (
    <div className="mb-3 overflow-hidden rounded-xl border border-violet-200 bg-violet-50/50">
      <div className="flex items-center gap-2 px-4 py-2.5">
        <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-700">
          Suggested reply
        </span>
        <span className="text-[12px] text-violet-900/60">
          Drafted from the email — check it before sending.
        </span>
        <button
          onClick={() => setOpen((o) => !o)}
          className="ml-auto text-[12px] font-medium text-violet-700 hover:underline"
        >
          {open ? "Hide" : "Read it"}
        </button>
      </div>

      {draft.internalNotes.length > 0 && (
        <ul className="mx-4 mb-2.5 space-y-1 rounded-lg bg-amber-50 px-3 py-2 text-[12px] text-amber-900">
          {draft.internalNotes.map((note, i) => (
            <li key={i}>⚠ {note}</li>
          ))}
        </ul>
      )}

      {open && (
        <div className="mx-4 mb-3 rounded-lg border border-violet-100 bg-white p-3">
          <div
            className="prose-sm max-w-none text-[13px] leading-relaxed text-gray-800 [&_li]:ml-4 [&_li]:list-disc [&_p]:mb-2"
            dangerouslySetInnerHTML={{ __html: draft.bodyHtml }}
          />
          {draft.rate && (
            <p className="mt-3 border-t border-gray-100 pt-2 text-[11px] text-gray-500">
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
        </div>
      )}

      <div className="flex items-center gap-2 px-4 pb-3">
        <button
          onClick={() => void use()}
          className="rounded-lg bg-violet-600 px-3.5 py-1.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-violet-700"
        >
          Use this draft
        </button>
        <button
          onClick={() => void dismiss()}
          className="rounded-lg px-3 py-1.5 text-sm text-gray-500 transition-colors hover:bg-gray-100"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

import type { TicketDispatchEntry, TicketMessage, TicketNote, TripEvent } from "../api/types";
import { Avatar } from "./Avatar";
import { DraftCard, type TicketDraft } from "./DraftCard";
import { displayName, formatDateTime } from "../lib/ui";

type TimelineItem =
  | { kind: "message"; at: string; message: TicketMessage }
  | { kind: "note"; at: string; note: TicketNote }
  | { kind: "draft"; at: string; draft: TicketDraft }
  | { kind: "dispatch"; at: string; entry: TicketDispatchEntry }
  | { kind: "tripEvent"; at: string; event: TripEvent };

/**
 * Conversation timeline: emails and internal notes interleaved in time order.
 * Notes are amber and clearly marked as not visible to the customer.
 */
export function ConversationTimeline({
  ticketId,
  messages,
  notes = [],
  dispatch = [],
  tripEvents = [],
  draft = null,
  onUseDraft,
  onDismissDraft,
}: {
  ticketId: string;
  messages: TicketMessage[];
  notes?: TicketNote[];
  /** Offers and answers about the booking, threaded in by time. */
  dispatch?: TicketDispatchEntry[];
  /** Changes made to the booking itself. */
  tripEvents?: TripEvent[];
  /** A drafted reply, shown in place and kept there for good. */
  draft?: TicketDraft | null;
  onUseDraft?: (text: string) => void;
  onDismissDraft?: () => void;
}) {
  const items: TimelineItem[] = [
    ...messages.map((m) => ({ kind: "message" as const, at: m.sentAt, message: m })),
    ...notes.map((n) => ({ kind: "note" as const, at: n.createdAt, note: n })),
    ...dispatch.map((d) => ({ kind: "dispatch" as const, at: d.at, entry: d })),
    ...tripEvents.map((e) => ({ kind: "tripEvent" as const, at: e.createdAt, event: e })),
    ...(draft ? [{ kind: "draft" as const, at: draft.createdAt, draft }] : []),
  ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

  if (items.length === 0) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white p-8 text-center text-sm text-gray-500">
        No messages yet.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {items.map((item) => {
        if (item.kind === "draft") {
          return (
            <DraftCard
              key={`draft-${item.draft.id}`}
              draft={item.draft}
              at={formatDateTime(item.at)}
              onUse={(text) => onUseDraft?.(text)}
              onDismiss={() => onDismissDraft?.()}
            />
          );
        }

        if (item.kind === "tripEvent") {
          return <BookingChange key={`event-${item.event.id}`} event={item.event} />;
        }

        if (item.kind === "dispatch") {
          return <DispatchEntry key={`dispatch-${item.entry.id}`} entry={item.entry} />;
        }

        if (item.kind === "note") {
          const n = item.note;
          // A note with no author is Adam's — he re-reads a customer's reply
          // and can change a booking off the back of it, and that has to be
          // visible here rather than only in a server log.
          const author = n.author?.name ?? "Adam";
          return (
            <div key={`note-${n.id}`} className="flex gap-3">
              <Avatar name={author} size={9} />
              <div className="min-w-0 flex-1 overflow-hidden rounded-xl border border-amber-200/80 bg-amber-50/70 shadow-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-amber-200/60 px-4 py-2">
                  <div className="flex items-center gap-2 text-sm">
                    <span className="font-semibold text-gray-900">{author}</span>
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                      {n.author ? "Internal note" : "Adam · internal note"}
                    </span>
                  </div>
                  <span className="text-xs text-gray-400">{formatDateTime(n.createdAt)}</span>
                </div>
                <p className="whitespace-pre-wrap px-4 py-3 text-[14px] leading-relaxed text-gray-800">{n.body}</p>
              </div>
            </div>
          );
        }

        const m = item.message;
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
                    <span
                      className="cursor-help rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-gray-500"
                      // What the envelope actually said. Hovering answers
                      // "why is this filed as automated mail?" without
                      // anybody having to go and read raw headers.
                      title={
                        m.bulkSignals?.length
                          ? `Marked automated by: ${m.bulkSignals.join(", ")}`
                          : "Marked automated when it arrived. This message predates header recording, so the markers were not kept."
                      }
                    >
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

/** The words for each kind of dispatch traffic, and how it should read. */
const DISPATCH_LABEL: Record<TicketDispatchEntry["kind"], string> = {
  OFFER: "Job offered",
  ACCEPT: "Accepted",
  DECLINE: "Declined",
  TEXT: "Message",
  QUOTE_REQUEST: "Asked for a price",
  QUOTE: "Partner quoted",
};

/**
 * An offer, an answer, or a word with a driver — shown in the ticket that
 * caused it.
 *
 * Slate rather than the amber of an internal note, because these are a
 * different kind of thing: a note is somebody at the desk writing to the desk,
 * this is a real exchange with somebody outside it. Both are equally
 * not-the-customer, which is why the line at the bottom says so.
 *
 * An accepted offer is the one entry worth finding at a glance — it is the
 * moment the job stopped being unassigned — so that one is green.
 */
function DispatchEntry({ entry }: { entry: TicketDispatchEntry }) {
  const accepted = entry.kind === "ACCEPT";
  const declined = entry.kind === "DECLINE";
  const tone = accepted
    ? "border-emerald-200 bg-emerald-50"
    : declined
      ? "border-rose-200 bg-rose-50"
      : "border-slate-200 bg-slate-50";

  // Who this was with, and — for anything inbound — who typed it on their
  // behalf. Until drivers have their own links somebody at the desk is
  // standing in, and the timeline should not let that pass as the driver.
  const who =
    entry.direction === "OUT"
      ? `${DISPATCH_LABEL[entry.kind]} to ${entry.contactName}`
      : `${entry.contactName} — ${DISPATCH_LABEL[entry.kind].toLowerCase()}`;
  const by =
    entry.direction === "OUT"
      ? entry.authorName
      : entry.actedByName
        ? `entered by ${entry.actedByName}`
        : null;

  return (
    <div className={`rounded-xl border px-4 py-2.5 ${tone}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-semibold text-gray-900">
          {who}
          <span className="ml-2 rounded-full bg-white/70 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-gray-600">
            {entry.contactKind === "DRIVER" ? "Driver" : "Partner"}
          </span>
        </p>
        <span className="text-xs text-gray-500">
          {by ? `${by} · ` : ""}
          {formatDateTime(entry.at)}
        </span>
      </div>
      <p className="mt-1.5 whitespace-pre-wrap text-[13px] leading-relaxed text-gray-800">
        {entry.body}
      </p>
      <p className="mt-1.5 text-[11px] text-gray-500">Dispatch — never sent to the customer.</p>
    </div>
  );
}

/**
 * A change made to the booking, shown in the ticket that asked for it.
 *
 * The record already existed — it is what the History button in Operations
 * shows — but it lived only there, so a ticket could hold a customer asking
 * for a later pickup and give no sign that anybody had moved it. The request
 * and the answer belong on the same page.
 *
 * Quiet by design: a thin line rather than a card, because on a busy booking
 * these outnumber everything else and are usually read at a glance.
 */
function BookingChange({ event }: { event: TripEvent }) {
  const headline =
    event.kind === "CREATED"
      ? "Reservation created"
      : event.kind === "CANCELLED"
        ? "Reservation cancelled"
        : "Reservation changed";

  return (
    <div className="rounded-lg border border-gray-200 bg-white px-4 py-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-xs font-semibold text-gray-700">
          {headline}
          <span className="ml-2 font-normal text-gray-500">
            by {event.actorName}
            {event.source ? ` · ${event.source}` : ""}
          </span>
        </p>
        <span className="text-xs text-gray-400">{formatDateTime(event.createdAt)}</span>
      </div>
      {event.changes.length > 0 && (
        <ul className="mt-1 space-y-0.5">
          {event.changes.map((c, i) => (
            <li key={`${c.field}-${i}`} className="text-xs text-gray-600">
              <span className="font-medium text-gray-700">{c.field}</span>
              {/* "from nothing" reads better than an empty gap where a value
                  should be — a field that was blank is a fact worth stating. */}
              {c.from ? ` — ${c.from}` : " — not set"} → {c.to ?? "not set"}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

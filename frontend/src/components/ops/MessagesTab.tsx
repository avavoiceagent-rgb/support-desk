// Talking to a driver or a partner about a job.
//
// Both sides are here on purpose. Until drivers have links of their own,
// somebody at the desk plays both parts to test the flow, so the composer has
// a switch: send as the desk, or answer as the contact. Everything typed as
// the contact is recorded as having been typed by whoever was signed in —
// nothing in this thread should ever read as though a real driver said it when
// they did not.
//
// Accepting an offer really assigns the driver. It goes through the same
// endpoint as the Reservations screen, so a driver who is already out gets the
// same refusal, in the same words.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  dispatchApi,
  opsApi,
  type Affiliate,
  type ContactKind,
  type DispatchMessage,
  type Driver,
  type Trip,
} from "../../api/ops";
import { Button, ErrorNote, Field, apiMessage, inputClass, when } from "./shared";
import { money, parseMoney } from "../../lib/money";

interface ContactOption {
  kind: ContactKind;
  id: string;
  label: string;
  detail: string;
}

function Bubble({ message }: { message: DispatchMessage }) {
  const outbound = message.direction === "OUT";
  const isOffer = message.kind === "OFFER";
  const isAccept = message.kind === "ACCEPT";
  const isDecline = message.kind === "DECLINE";
  const isAsk = message.kind === "QUOTE_REQUEST";
  const isQuote = message.kind === "QUOTE";

  const tone = isOffer
    ? "border-indigo-200 bg-indigo-50"
    : isAccept
      ? "border-emerald-200 bg-emerald-50"
      : isDecline
        ? "border-amber-200 bg-amber-50"
        : isAsk || isQuote
          ? "border-sky-200 bg-sky-50"
          : outbound
            ? "border-gray-200 bg-white"
            : "border-gray-200 bg-gray-50";

  return (
    <div className={`flex ${outbound ? "justify-start" : "justify-end"}`}>
      <div className={`max-w-[85%] rounded-xl border px-3 py-2 shadow-sm ${tone}`}>
        <div className="mb-0.5 flex flex-wrap items-baseline gap-x-2">
          <span className="text-[11px] font-medium text-gray-700">
            {outbound ? (message.authorName ?? "The desk") : "Them"}
          </span>
          {isOffer && (
            <span className="rounded-full bg-indigo-100 px-1.5 py-0.5 text-[10px] font-medium text-indigo-800">
              Job offer
            </span>
          )}
          {isAccept && (
            <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-800">
              Accepted
            </span>
          )}
          {isDecline && (
            <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800">
              Declined
            </span>
          )}
          {isAsk && (
            <span className="rounded-full bg-sky-100 px-1.5 py-0.5 text-[10px] font-medium text-sky-800">
              Asked for a price
            </span>
          )}
          {isQuote && (
            <span className="rounded-full bg-sky-100 px-1.5 py-0.5 text-[10px] font-medium text-sky-800">
              Quoted {message.amountCents === null ? "" : money(message.amountCents)}
            </span>
          )}
          <span className="text-[10px] text-gray-400">{when(message.createdAt)}</span>
        </div>
        <p className="whitespace-pre-wrap text-sm text-gray-800">{message.body}</p>
        {message.actedByName && (
          <p className="mt-1 text-[10px] italic text-gray-400">
            typed by {message.actedByName} standing in
          </p>
        )}
      </div>
    </div>
  );
}

export function MessagesTab({
  drivers,
  affiliates,
}: {
  drivers: Driver[];
  affiliates: Affiliate[];
}) {
  const contacts: ContactOption[] = useMemo(
    () => [
      ...drivers
        .filter((d) => d.active)
        .map((d) => ({
          kind: "DRIVER" as const,
          id: d.id,
          label: d.name,
          detail: d.defaultVehicle?.label ?? "Driver",
        })),
      ...affiliates
        .filter((a) => a.active)
        .map((a) => ({
          kind: "AFFILIATE" as const,
          id: a.id,
          label: a.company,
          detail: "Partner",
        })),
    ],
    [drivers, affiliates]
  );

  const [selected, setSelected] = useState<string>("");
  const [search, setSearch] = useState("");
  const [messages, setMessages] = useState<DispatchMessage[]>([]);
  const [trips, setTrips] = useState<Trip[]>([]);
  const [body, setBody] = useState("");
  const [asContact, setAsContact] = useState(false);
  const [offerTripId, setOfferTripId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pending, setPending] = useState<{
    drivers: Record<string, number>;
    affiliates: Record<string, number>;
  }>({ drivers: {}, affiliates: {} });
  const bottom = useRef<HTMLDivElement>(null);

  /**
   * The list in two named halves, filtered by whatever has been typed.
   *
   * It used to be one unbroken scroll: sixteen drivers and then eleven
   * partners, under a single grey "Drivers and partners" heading nobody reads.
   * Amar asked for partners to be added to this screen — they had been here
   * all along, sitting below a screenful of drivers. A feature you cannot find
   * is a feature you do not have.
   */
  const groups = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const matches = (c: ContactOption) =>
      !needle || c.label.toLowerCase().includes(needle) || c.detail.toLowerCase().includes(needle);
    return [
      { title: "Drivers", items: contacts.filter((c) => c.kind === "DRIVER" && matches(c)) },
      { title: "Partners", items: contacts.filter((c) => c.kind === "AFFILIATE" && matches(c)) },
    ];
  }, [contacts, search]);

  useEffect(() => {
    if (!selected && contacts.length) setSelected(`${contacts[0].kind}:${contacts[0].id}`);
  }, [contacts, selected]);

  const contact = contacts.find((c) => `${c.kind}:${c.id}` === selected) ?? null;

  const load = useCallback(async () => {
    if (!contact) return;
    try {
      setMessages(await dispatchApi.messages(contact.kind, contact.id));
      setError(null);
    } catch (err) {
      setError(apiMessage(err));
    }
  }, [contact]);

  useEffect(() => {
    void load();
  }, [load]);

  // Soonest first, and not filtered to unassigned work.
  //
  // It was, and the list came back empty every time: every seeded trip has
  // somebody on it, so "Send offer" was a button that could never be pressed.
  // Offering a job that is already covered is a real thing a dispatcher does —
  // bringing a farmed-out job back in-house, or moving it when somebody calls
  // in sick — so the option is here with the current holder named, rather than
  // hidden behind a filter that made the feature look broken.
  useEffect(() => {
    opsApi
      .trips({
        from: new Date().toISOString(),
        status: "SCHEDULED",
        sort: "pickupAt",
        dir: "asc",
        limit: 60,
      })
      .then((r) => setTrips(r.trips))
      .catch(() => setTrips([]));
  }, [messages.length]);

  // Who is waiting on an answer. Re-read whenever the thread changes, since
  // sending an offer or recording a reply is exactly what moves these counts.
  useEffect(() => {
    dispatchApi
      .pending()
      .then(setPending)
      .catch(() => setPending({ drivers: {}, affiliates: {} }));
  }, [messages.length]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "nearest" });
  }, [messages]);

  async function run(work: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await work();
      await load();
    } catch (err) {
      setError(apiMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const answered = new Set(messages.filter((m) => m.respondsToId).map((m) => m.respondsToId));

  return (
    <div className="grid gap-4 lg:grid-cols-[16rem_1fr]">
      <div className="rounded-xl border border-gray-200 bg-white p-2 shadow-sm">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search drivers and partners"
          className="mb-1 w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
        />
        <div className="max-h-[30rem] overflow-y-auto">
          {groups.every((g) => g.items.length === 0) && (
            <p className="px-2 py-3 text-sm text-gray-500">Nobody by that name.</p>
          )}
          {groups.map((group) =>
            group.items.length === 0 ? null : (
              <div key={group.title} className="mb-1">
                {/* Sticky so the heading is still on screen after scrolling
                    into the partners, which is where this went wrong. */}
                <p className="sticky top-0 z-10 bg-white px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                  {group.title}
                  <span className="ml-1 font-normal text-gray-400">{group.items.length}</span>
                </p>
                {group.items.map((c) => {
                  const key = `${c.kind}:${c.id}`;
                  const waiting =
                    (c.kind === "DRIVER" ? pending.drivers[c.id] : pending.affiliates[c.id]) ?? 0;
                  return (
                    <button
                      key={key}
                      onClick={() => setSelected(key)}
                      className={`block w-full rounded-lg px-2 py-1.5 text-left transition-colors ${
                        key === selected
                          ? "bg-indigo-50 text-indigo-900"
                          : waiting
                            ? // Somebody owes us an answer. Marked on the list
                              // itself because the alternative is clicking
                              // through fourteen drivers to find the one
                              // holding a job up.
                              "bg-amber-50/70 hover:bg-amber-50"
                            : "hover:bg-gray-50"
                      }`}
                    >
                      <span className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm font-medium">{c.label}</span>
                        {waiting > 0 && (
                          <span
                            className="shrink-0 rounded-full bg-amber-500 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white"
                            // "Ask" covers both sorts: a driver gets offers, a
                            // partner gets a rate request first and an offer
                            // only once we have agreed the money.
                            title={`${waiting} ${waiting === 1 ? "message" : "messages"} sent, no answer yet`}
                          >
                            {waiting}
                          </span>
                        )}
                      </span>
                      <span className="block truncate text-[11px] text-gray-500">
                        {waiting > 0 ? `Waiting on their answer · ${c.detail}` : c.detail}
                      </span>
                    </button>
                  );
                })}
              </div>
            )
          )}
        </div>
      </div>

      <section className="flex min-h-[32rem] flex-col overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
        <div className="border-b border-gray-100 px-5 py-3">
          <h2 className="text-sm font-semibold text-gray-900">{contact?.label ?? "Nobody selected"}</h2>
          <p className="text-xs text-gray-500">
            Nothing here reaches a real phone. You are both sides for now.
          </p>
        </div>

        <div className="flex-1 space-y-2 overflow-y-auto bg-gray-50/50 p-4">
          {messages.length === 0 && (
            <p className="py-10 text-center text-sm text-gray-500">No messages yet.</p>
          )}
          {messages.map((m) => (
            <div key={m.id}>
              <Bubble message={m} />
              {/* A price belongs in the conversation that asked for it.
                  It was only on the reservation panel, so the first person
                  to use this came here — which is where a partner's answer
                  obviously goes — typed 300 into the message box, and sent
                  the partner the number 300 from the desk. */}
              {m.kind === "QUOTE_REQUEST" && !answered.has(m.id) && (
                <QuoteReply
                  requestId={m.id}
                  busy={busy}
                  onQuoted={(cents) =>
                    void run(async () => {
                      await opsApi.recordQuote(m.id, cents);
                      setNote(`Recorded ${money(cents)} from ${contact?.label ?? "them"}.`);
                    })
                  }
                />
              )}
              {m.kind === "OFFER" && !answered.has(m.id) && (
                <div className="mt-1 flex justify-end gap-2">
                  <Button
                    kind="primary"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const r = await dispatchApi.respond(m.id, true);
                        if (r.trip) setNote(`${r.trip.reference} is now ${r.trip.driver?.name ?? r.trip.affiliate?.company}.`);
                      })
                    }
                  >
                    Accept
                  </Button>
                  <Button disabled={busy} onClick={() => void run(() => dispatchApi.respond(m.id, false))}>
                    Decline
                  </Button>
                </div>
              )}
            </div>
          ))}
          <div ref={bottom} />
        </div>

        <div className="space-y-2 border-t border-gray-100 p-3">
          <ErrorNote message={error} />
          {note && (
            <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
              {note}
            </p>
          )}

          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[16rem] flex-1">
              <Field label="Offer a job">
                <select
                  value={offerTripId}
                  onChange={(e) => setOfferTripId(e.target.value)}
                  className={inputClass}
                >
                  {/* Not "unassigned" — the list deliberately includes jobs
                      somebody already has, so a change can be put back to the
                      driver holding it. The label said otherwise and made the
                      one thing this screen is for look unavailable. */}
                  <option value="">Choose a job…</option>
                  {trips.map((t) => {
                    const holder = t.driver?.name ?? t.affiliate?.company;
                    return (
                      <option key={t.id} value={t.id}>
                        {t.reference} · {when(t.pickupAt)} · {t.bookedHours}h ·{" "}
                        {t.vehicleClass.toLowerCase()} —{" "}
                        {holder ? `currently ${holder}` : "nobody assigned"}
                      </option>
                    );
                  })}
                </select>
              </Field>
            </div>
            <Button
              disabled={!offerTripId || !contact || busy}
              onClick={() =>
                void run(async () => {
                  await dispatchApi.sendOffer(contact!.kind, contact!.id, offerTripId);
                  setOfferTripId("");
                })
              }
            >
              Send offer
            </Button>
          </div>

          {(() => {
            // This used to test `.driverId` alone and promise "they come off
            // it" — which showed nothing at all for a job already with a
            // partner, and was untrue for a partner offer, because assigning
            // one side did not clear the other. Both halves are fixed: the
            // desk now really does take a job off whoever had it, and this
            // says who that is.
            const job = trips.find((t) => t.id === offerTripId);
            const holder = job?.driver?.name ?? job?.affiliate?.company;
            if (!job || !holder) return null;
            return (
              <p className="text-[11px] text-amber-700">
                {job.reference} is with {holder}. Accepting this offer takes it off them.
              </p>
            );
          })()}

          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!contact || !body.trim()) return;
              void run(async () => {
                await dispatchApi.sendText(contact.kind, contact.id, body, asContact ? "IN" : "OUT");
                setBody("");
              });
            }}
            className="flex items-end gap-2"
          >
            <input
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={asContact ? `Reply as ${contact?.label ?? "them"}…` : "Message from the desk…"}
              className={inputClass}
            />
            <Button kind="primary" type="submit" disabled={busy || !body.trim()}>
              Send
            </Button>
          </form>

          <label className="flex items-center gap-2 text-xs text-gray-600">
            <input
              type="checkbox"
              checked={asContact}
              onChange={(e) => setAsContact(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
            />
            Answer as {contact?.label ?? "them"} — recorded as typed by you
          </label>
        </div>
      </section>
    </div>
  );
}

/**
 * The price, answered where it was asked.
 *
 * This is the box that was missing. The desk sent Liberty Bell a request for
 * a price, Liberty Bell's thread is where their answer belongs, and the only
 * place to record one was a panel on the ticket. So the first person to use
 * the feature did the obvious thing — opened the thread, typed 300 into the
 * message box — and sent a partner the number 300 from the desk.
 *
 * A price typed here is refused unless it is one. A number that reaches a
 * customer must not have been guessed at on the way.
 */
function QuoteReply({
  requestId,
  busy,
  onQuoted,
}: {
  requestId: string;
  busy: boolean;
  onQuoted: (amountCents: number) => void;
}) {
  const [typed, setTyped] = useState("");
  const cents = parseMoney(typed);
  const unreadable = typed.trim().length > 0 && cents === null;

  return (
    <div className="mt-1 flex flex-wrap items-center justify-end gap-2">
      <label className="text-[11px] text-gray-500" htmlFor={`quote-${requestId}`}>
        Their price
      </label>
      <input
        id={`quote-${requestId}`}
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        placeholder="e.g. 300"
        className={`w-28 rounded-lg border px-2 py-1 text-sm shadow-sm focus:outline-none ${
          unreadable ? "border-red-300 bg-red-50" : "border-gray-300"
        }`}
      />
      <Button
        kind="primary"
        disabled={busy || cents === null}
        onClick={() => {
          if (cents === null) return;
          onQuoted(cents);
          setTyped("");
        }}
      >
        Record their quote
      </Button>
      {unreadable && (
        <p className="w-full text-right text-[11px] text-red-700">
          That is not a price. Type it like 300 or 300.50.
        </p>
      )}
    </div>
  );
}

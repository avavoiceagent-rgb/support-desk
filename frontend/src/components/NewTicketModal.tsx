import { useState } from "react";
import { createPortal } from "react-dom";
import { api, ApiError } from "../api/client";
import type { PublicUser, TicketChannel, TicketQueue } from "../api/types";
import { CHANNELS, QUEUES } from "../lib/statuses";

const inputClass =
  "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm placeholder:text-gray-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20";

/** Dialog for logging a ticket by hand — e.g. a request that came in by phone. */
export function NewTicketModal({
  users,
  onClose,
  onCreated,
}: {
  users: PublicUser[];
  onClose: () => void;
  onCreated: (ticketId: string) => void;
}) {
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [channel, setChannel] = useState<TicketChannel>("PHONE");
  const [queue, setQueue] = useState<TicketQueue | "">("");
  const [assigneeId, setAssigneeId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const r = await api.post<{ ticket: { id: string } }>("/tickets", {
        subject,
        body: body || undefined,
        requesterName: name || undefined,
        requesterEmail: email || undefined,
        requesterPhone: phone || undefined,
        channel,
        queue: queue || null,
        assigneeId: assigneeId || null,
      });
      onCreated(r.ticket.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to create ticket.");
      setSaving(false);
    }
  }

  return createPortal(
    <>
      <div className="fixed inset-0 z-40 bg-gray-900/30" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
        <form
          onSubmit={handleCreate}
          onClick={(e) => e.stopPropagation()}
          className="w-full max-w-lg overflow-hidden rounded-xl border border-gray-200 bg-white shadow-2xl"
        >
          <div className="flex items-center justify-between border-b border-gray-100 px-5 py-3.5">
            <h2 className="text-base font-semibold text-gray-900">New ticket</h2>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700"
            >
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M18 6 6 18" />
                <path d="m6 6 12 12" />
              </svg>
            </button>
          </div>

          <div className="max-h-[70vh] space-y-3 overflow-y-auto p-5">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-gray-400">Channel</label>
                <select className={inputClass} value={channel} onChange={(e) => setChannel(e.target.value as TicketChannel)}>
                  {CHANNELS.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-gray-400">Queue</label>
                <select className={inputClass} value={queue} onChange={(e) => setQueue(e.target.value as TicketQueue | "")}>
                  <option value="">No queue</option>
                  {QUEUES.map((q) => (
                    <option key={q.value} value={q.value}>
                      {q.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-gray-400">Subject</label>
              <input className={inputClass} placeholder="What is this about?" value={subject} onChange={(e) => setSubject(e.target.value)} required />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-gray-400">Customer name</label>
                <input className={inputClass} placeholder="Jane Doe" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-gray-400">Phone</label>
                <input className={inputClass} placeholder="+1 555 000 0000" value={phone} onChange={(e) => setPhone(e.target.value)} />
              </div>
            </div>

            <div>
              <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-gray-400">
                Email <span className="normal-case text-gray-400">(needed to reply by email)</span>
              </label>
              <input type="email" className={inputClass} placeholder="jane@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>

            <div>
              <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-gray-400">Details</label>
              <textarea
                className={`${inputClass} resize-y`}
                rows={4}
                placeholder="What did the customer ask for?"
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
            </div>

            <div>
              <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-gray-400">Assign to</label>
              <select className={inputClass} value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
                <option value="">Unassigned</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            </div>

            {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
          </div>

          <div className="flex justify-end gap-2 border-t border-gray-100 bg-gray-50/60 px-5 py-3">
            <button type="button" onClick={onClose} className="rounded-lg px-3.5 py-2 text-sm text-gray-500 hover:bg-gray-100">
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || !subject.trim()}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-700 disabled:opacity-50"
            >
              {saving ? "Creating…" : "Create ticket"}
            </button>
          </div>
        </form>
      </div>
    </>,
    document.body
  );
}

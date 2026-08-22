// The partner list.
//
// Two kinds of partner sit in one table on purpose. An overflow partner is a
// local company that takes a job when every one of our cars is out; the rest
// cover places we do not drive to at all. Which one a row is changes what a
// dispatcher does with it, so it is a visible tag rather than a column of
// true/false.
//
// Nothing here is deleted. Trips point at partners and last month's history
// has to stay readable, so "remove" means deactivate — out of every future
// suggestion, still attached to the trips it ran.

import { useMemo, useState, type FormEvent } from "react";
import { opsApi, type Affiliate } from "../../api/ops";
import {
  Button,
  Card,
  Empty,
  ErrorNote,
  Field,
  Modal,
  apiMessage,
  inputClass,
} from "./shared";

/** "NY, NJ" both ways round — a text box is kinder here than a state picker. */
function parseList(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const PREFERENCE_LABEL: Record<number, string> = {
  1: "First call",
  2: "Second",
  3: "Third",
  4: "Fourth",
  5: "Last resort",
};

function PreferencePill({ value }: { value: number }) {
  const tone =
    value <= 1 ? "bg-emerald-100 text-emerald-800" : value >= 5 ? "bg-gray-100 text-gray-500" : "bg-sky-100 text-sky-800";
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${tone}`}>
      {PREFERENCE_LABEL[value] ?? `Preference ${value}`}
    </span>
  );
}

function AffiliateEditor({
  affiliate,
  onClose,
  onSaved,
}: {
  affiliate: Affiliate | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [company, setCompany] = useState(affiliate?.company ?? "");
  const [contactName, setContactName] = useState(affiliate?.contactName ?? "");
  const [phone, setPhone] = useState(affiliate?.phone ?? "");
  const [email, setEmail] = useState(affiliate?.email ?? "");
  const [states, setStates] = useState((affiliate?.coverageStates ?? []).join(", "));
  const [cities, setCities] = useState((affiliate?.coverageCities ?? []).join(", "));
  const [overflowPartner, setOverflowPartner] = useState(affiliate?.overflowPartner ?? false);
  const [hourlyRate, setHourlyRate] = useState(
    affiliate?.hourlyRateUsd == null ? "" : String(affiliate.hourlyRateUsd)
  );
  const [preference, setPreference] = useState(String(affiliate?.preference ?? 3));
  const [active, setActive] = useState(affiliate?.active ?? true);
  const [notes, setNotes] = useState(affiliate?.notes ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const body = {
        company: company.trim(),
        contactName: contactName.trim() || null,
        phone: phone.trim(),
        email: email.trim(),
        coverageStates: parseList(states.toUpperCase()),
        coverageCities: parseList(cities),
        overflowPartner,
        hourlyRateUsd: hourlyRate.trim() === "" ? null : Number(hourlyRate),
        preference: Number(preference),
        active,
        notes: notes.trim() || null,
      };
      if (affiliate) await opsApi.updateAffiliate(affiliate.id, body);
      else await opsApi.createAffiliate(body);
      onSaved();
    } catch (err) {
      setError(apiMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={affiliate ? `Edit ${affiliate.company}` : "Add partner"} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Company">
          <input value={company} onChange={(e) => setCompany(e.target.value)} className={inputClass} required />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Contact name">
            <input value={contactName} onChange={(e) => setContactName(e.target.value)} className={inputClass} />
          </Field>
          <Field label="Phone">
            <input value={phone} onChange={(e) => setPhone(e.target.value)} className={inputClass} required />
          </Field>
        </div>

        <Field label="Email">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={inputClass}
            required
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="States covered" hint="Two-letter codes, comma separated: MA, CT">
            <input value={states} onChange={(e) => setStates(e.target.value)} className={inputClass} />
          </Field>
          <Field label="Cities covered" hint="Optional, when a state is too broad">
            <input value={cities} onChange={(e) => setCities(e.target.value)} className={inputClass} />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Hourly rate (USD)" hint="Leave blank if it varies by job">
            <input
              type="number"
              min={0}
              value={hourlyRate}
              onChange={(e) => setHourlyRate(e.target.value)}
              className={inputClass}
            />
          </Field>
          <Field label="Preference">
            <select value={preference} onChange={(e) => setPreference(e.target.value)} className={inputClass}>
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n} — {PREFERENCE_LABEL[n]}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={overflowPartner}
            onChange={(e) => setOverflowPartner(e.target.checked)}
            className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
          />
          Overflow partner — takes our local work when every car is busy
        </label>

        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
            className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
          />
          Active — offered for new work
        </label>

        <Field label="Notes">
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            className={inputClass}
          />
        </Field>

        <ErrorNote message={error} />

        <div className="flex justify-end gap-2 pt-1">
          <Button onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button kind="primary" type="submit" disabled={saving}>
            {saving ? "Saving…" : affiliate ? "Save changes" : "Add partner"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function AffiliatesTab({
  affiliates,
  isAdmin,
  onChanged,
}: {
  affiliates: Affiliate[];
  isAdmin: boolean;
  onChanged: () => void;
}) {
  const [showInactive, setShowInactive] = useState(false);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Affiliate | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return affiliates.filter((a) => {
      if (!showInactive && !a.active) return false;
      if (!q) return true;
      return (
        a.company.toLowerCase().includes(q) ||
        (a.contactName ?? "").toLowerCase().includes(q) ||
        a.email.toLowerCase().includes(q) ||
        a.coverageStates.join(" ").toLowerCase().includes(q) ||
        a.coverageCities.join(" ").toLowerCase().includes(q)
      );
    });
  }, [affiliates, showInactive, query]);

  const inactiveCount = affiliates.filter((a) => !a.active).length;

  async function toggleActive(a: Affiliate) {
    setError(null);
    try {
      await opsApi.updateAffiliate(a.id, { active: !a.active });
      onChanged();
    } catch (err) {
      setError(apiMessage(err));
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-white px-5 py-4 shadow-sm">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search company, contact, state…"
          className={`${inputClass} max-w-xs`}
        />
        <label className="flex items-center gap-2 text-sm text-gray-600">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
            className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
          />
          Show deactivated ({inactiveCount})
        </label>
        {isAdmin && (
          <div className="ml-auto">
            <Button kind="primary" onClick={() => setAdding(true)}>
              Add partner
            </Button>
          </div>
        )}
      </div>

      <ErrorNote message={error} />

      <Card title={`Partners · ${visible.length} shown`}>
        {visible.length === 0 && <Empty>No partners match that.</Empty>}
        {visible.map((a) => (
          <div
            key={a.id}
            className={`border-t border-gray-100 px-5 py-3 first:border-t-0 ${a.active ? "" : "bg-gray-50"}`}
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-gray-900">{a.company}</span>
                  <PreferencePill value={a.preference} />
                  {a.overflowPartner && (
                    <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-medium text-violet-800">
                      Overflow
                    </span>
                  )}
                  {!a.active && (
                    <span className="rounded-full bg-gray-200 px-2 py-0.5 text-[11px] font-medium text-gray-600">
                      Deactivated
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xs text-gray-600">
                  {a.contactName ? `${a.contactName} · ` : ""}
                  {a.phone} · {a.email}
                  {a.hourlyRateUsd != null && ` · $${a.hourlyRateUsd}/hr`}
                </p>
                <p className="mt-0.5 text-xs text-gray-500">
                  {a.coverageStates.length > 0 ? a.coverageStates.join(", ") : "No states listed"}
                  {a.coverageCities.length > 0 && ` · ${a.coverageCities.join(", ")}`}
                </p>
                {a.notes && <p className="mt-1 text-xs italic text-gray-500">{a.notes}</p>}
              </div>
              {isAdmin && (
                <div className="flex shrink-0 gap-2">
                  <Button onClick={() => setEditing(a)}>Edit</Button>
                  <Button kind={a.active ? "danger" : "secondary"} onClick={() => void toggleActive(a)}>
                    {a.active ? "Deactivate" : "Reactivate"}
                  </Button>
                </div>
              )}
            </div>
          </div>
        ))}
      </Card>

      {(adding || editing) && (
        <AffiliateEditor
          affiliate={editing}
          onClose={() => {
            setAdding(false);
            setEditing(null);
          }}
          onSaved={() => {
            setAdding(false);
            setEditing(null);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

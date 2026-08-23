// The partner list, as a table.
//
// Sorted in the browser, and that is not the shortcut it looks like: the API
// hands over every partner in one response, so the rows being ordered here are
// the whole list. The reservations table deliberately does the opposite,
// because there the page is fifty rows out of hundreds and sorting what
// happens to be loaded would put the first "A" of page three at the top and
// call it alphabetical.
//
// Nothing here is ever deleted. Trips point at partners and last month's
// history has to stay readable, so "remove" means deactivate: out of every
// future suggestion, still attached to the work it ran.

import { useMemo, useState, type FormEvent } from "react";
import { opsApi, type Affiliate } from "../../api/ops";
import { RateCardModal } from "./RateCardModal";
import {
  Button,
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
  const [baseAddress, setBaseAddress] = useState(affiliate?.baseAddress ?? "");
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
        baseAddress: baseAddress.trim() || null,
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

        <Field label="Where their cars are based" hint="The centre every distance band measures from">
          <input
            value={baseAddress}
            onChange={(e) => setBaseAddress(e.target.value)}
            placeholder="Boston, MA"
            className={inputClass}
          />
        </Field>

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
          <Field label="Fallback hourly rate (USD)" hint="Used only where the rate card has no band">
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

type SortKey = "company" | "preference" | "coverage" | "contactName" | "phone" | "email" | "rate" | "active";

interface Sort {
  by: SortKey;
  dir: "asc" | "desc";
}

const COLUMNS: { key: SortKey; label: string; align?: "right"; className?: string }[] = [
  { key: "company", label: "Company" },
  { key: "preference", label: "Call order" },
  { key: "coverage", label: "Covers", className: "w-1/3" },
  { key: "contactName", label: "Contact" },
  { key: "phone", label: "Phone" },
  { key: "email", label: "Email", className: "w-1/4" },
  { key: "rate", label: "Fallback", align: "right" },
  { key: "active", label: "Status" },
];

/** Where they work, in one line: states first, then the cities they name. */
function coverage(a: Affiliate): string {
  const states = a.coverageStates.join(", ");
  const cities = a.coverageCities.join(", ");
  if (!states && !cities) return "—";
  if (!cities) return states;
  return states ? `${states} · ${cities}` : cities;
}

/** What each column sorts on. Nulls sort last whichever way the arrow points. */
function sortValue(a: Affiliate, key: SortKey): string | number {
  switch (key) {
    case "company":
      return a.company.toLowerCase();
    case "preference":
      return a.preference;
    case "coverage":
      return coverage(a).toLowerCase();
    case "contactName":
      return (a.contactName ?? "\uffff").toLowerCase();
    case "phone":
      return a.phone;
    case "email":
      return a.email.toLowerCase();
    case "rate":
      // "Varies" is not a price, so it sits at the end rather than pretending
      // to be zero and heading the cheapest-first list.
      return a.hourlyRateUsd ?? Number.MAX_SAFE_INTEGER;
    case "active":
      return a.active ? 0 : 1;
  }
}

function HeaderCell({
  column,
  sort,
  onSort,
}: {
  column: (typeof COLUMNS)[number];
  sort: Sort;
  onSort: (key: SortKey) => void;
}) {
  const active = sort.by === column.key;
  return (
    <th
      className={`whitespace-nowrap px-3 py-2 text-[11px] font-medium ${
        column.align === "right" ? "text-right" : "text-left"
      } ${column.className ?? ""}`}
    >
      <button
        onClick={() => onSort(column.key)}
        className={`inline-flex items-center gap-1 rounded px-1 py-0.5 transition-colors ${
          active ? "text-indigo-700" : "text-gray-500 hover:text-gray-900"
        }`}
      >
        {column.label}
        <span className={active ? "" : "opacity-0"}>{sort.dir === "asc" ? "▲" : "▼"}</span>
      </button>
    </th>
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
  const [sort, setSort] = useState<Sort>({ by: "preference", dir: "asc" });
  const [editing, setEditing] = useState<Affiliate | null>(null);
  const [adding, setAdding] = useState(false);
  const [ratesFor, setRatesFor] = useState<Affiliate | null>(null);
  const [error, setError] = useState<string | null>(null);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = affiliates.filter((a) => {
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

    const flip = sort.dir === "asc" ? 1 : -1;
    return [...matched].sort((x, y) => {
      const a = sortValue(x, sort.by);
      const b = sortValue(y, sort.by);
      if (a < b) return -flip;
      if (a > b) return flip;
      // Company name breaks every tie, so the list never reshuffles between
      // two identical renders.
      return x.company.localeCompare(y.company);
    });
  }, [affiliates, showInactive, query, sort]);

  function onSort(key: SortKey) {
    setSort((current) =>
      current.by === key ? { by: key, dir: current.dir === "asc" ? "desc" : "asc" } : { by: key, dir: "asc" }
    );
  }

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

      <section className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
        <div className="border-b border-gray-100 px-5 py-3">
          <h2 className="text-sm font-semibold text-gray-900">
            Partners · {visible.length} shown
          </h2>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[68rem] border-collapse text-sm">
            <thead className="border-b border-gray-200 bg-gray-50">
              <tr>
                {COLUMNS.map((c) => (
                  <HeaderCell key={c.label} column={c} sort={sort} onSort={onSort} />
                ))}
                <th className="whitespace-nowrap px-3 py-2 text-right text-[11px] font-medium text-gray-500">
                  Rates
                </th>
                {isAdmin && <th className="w-px px-3 py-2" />}
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 && (
                <tr>
                  <td
                    colSpan={COLUMNS.length + 2}
                    className="px-5 py-8 text-center text-sm text-gray-500"
                  >
                    No partners match that.
                  </td>
                </tr>
              )}
              {visible.map((a) => (
                <tr
                  key={a.id}
                  className={`border-b border-gray-100 last:border-b-0 hover:bg-indigo-50/40 ${
                    a.active ? "" : "bg-gray-50/60 text-gray-500"
                  }`}
                >
                  <td className="whitespace-nowrap px-3 py-1.5 font-medium text-gray-900">
                    {a.company}
                    {a.overflowPartner && (
                      <span className="ml-2 rounded-full bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium text-violet-800">
                        Overflow
                      </span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5">
                    <PreferencePill value={a.preference} />
                  </td>
                  <td className="max-w-0 truncate px-3 py-1.5 text-gray-600" title={coverage(a)}>
                    {coverage(a)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-gray-600">
                    {a.contactName ?? "—"}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 tabular-nums text-gray-600">{a.phone}</td>
                  <td className="max-w-0 truncate px-3 py-1.5 text-gray-600" title={a.email}>
                    {a.email}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-gray-700">
                    {a.hourlyRateUsd == null ? (
                      <span className="text-gray-400">varies</span>
                    ) : (
                      `$${a.hourlyRateUsd}/hr`
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-right">
                    <button
                      onClick={() => setRatesFor(a)}
                      className="text-xs font-medium text-indigo-600 hover:text-indigo-800"
                    >
                      Rate card
                    </button>
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5">
                    {a.active ? (
                      <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-800">
                        Active
                      </span>
                    ) : (
                      <span className="rounded-full bg-gray-200 px-2 py-0.5 text-[11px] font-medium text-gray-600">
                        Deactivated
                      </span>
                    )}
                  </td>
                  {isAdmin && (
                    <td className="whitespace-nowrap px-3 py-1.5 text-right">
                      <button
                        onClick={() => setEditing(a)}
                        className="text-xs font-medium text-indigo-600 hover:text-indigo-800"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => void toggleActive(a)}
                        className={`ml-3 text-xs font-medium ${
                          a.active ? "text-red-600 hover:text-red-800" : "text-gray-600 hover:text-gray-900"
                        }`}
                      >
                        {a.active ? "Deactivate" : "Reactivate"}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {ratesFor && (
        <RateCardModal affiliate={ratesFor} isAdmin={isAdmin} onClose={() => setRatesFor(null)} />
      )}

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

// What a partner charges, by how far out the job goes.
//
// A band covers [from, to) miles from where the partner's cars sit, priced per
// class of car, with the shortest it will ever be billed at. A blank cell is
// not free — it means they do not run that size of car out there, and a quote
// for it has to come back empty rather than guessed.
//
// The server refuses overlapping bands, and this shows that refusal in its own
// words: "That overlaps Metro (0–15 miles)" tells you what to change, where
// "Could not save" does not.

import { useCallback, useEffect, useState } from "react";
import {
  opsApi,
  VEHICLE_CLASSES,
  type Affiliate,
  type AffiliateZone,
  type VehicleClass,
  type ZoneInput,
} from "../../api/ops";
import { Button, ErrorNote, Modal, apiMessage, inputClass } from "./shared";

const CLASS_LABEL: Record<VehicleClass, string> = {
  SEDAN: "Sedan",
  SUV: "SUV",
  VAN: "Van",
  SPRINTER: "Sprinter",
};

const money = (cents: number) => `$${(cents / 100).toLocaleString("en-US")}`;

function bandRange(zone: { fromMiles: number; toMiles: number | null }): string {
  return zone.toMiles === null ? `${zone.fromMiles}+ mi` : `${zone.fromMiles}–${zone.toMiles} mi`;
}

/** A band being typed. Everything is a string until it is saved. */
interface Draft {
  label: string;
  fromMiles: string;
  toMiles: string;
  minimumHours: string;
  rates: Partial<Record<VehicleClass, string>>;
}

function toDraft(zone: AffiliateZone): Draft {
  const rates: Partial<Record<VehicleClass, string>> = {};
  for (const c of VEHICLE_CLASSES) {
    const cents = zone.rateCents?.[c];
    if (typeof cents === "number") rates[c] = String(cents / 100);
  }
  return {
    label: zone.label,
    fromMiles: String(zone.fromMiles),
    toMiles: zone.toMiles === null ? "" : String(zone.toMiles),
    minimumHours: String(zone.minimumHours),
    rates,
  };
}

const EMPTY: Draft = { label: "", fromMiles: "", toMiles: "", minimumHours: "3", rates: {} };

function toInput(draft: Draft): ZoneInput {
  const rateCents: Partial<Record<VehicleClass, number>> = {};
  for (const c of VEHICLE_CLASSES) {
    const typed = draft.rates[c]?.trim();
    // Blank means they do not run it. Zero would mean they run it for nothing.
    if (typed) rateCents[c] = Math.round(Number(typed) * 100);
  }
  return {
    label: draft.label.trim(),
    fromMiles: Number(draft.fromMiles || 0),
    toMiles: draft.toMiles.trim() === "" ? null : Number(draft.toMiles),
    minimumHours: Number(draft.minimumHours || 1),
    rateCents,
  };
}

function DraftRow({
  draft,
  setDraft,
  onSave,
  onCancel,
  saving,
  saveLabel,
}: {
  draft: Draft;
  setDraft: (d: Draft) => void;
  onSave: () => void;
  onCancel?: () => void;
  saving: boolean;
  saveLabel: string;
}) {
  const cell = "border-t border-gray-100 px-1.5 py-1.5";
  const small = `${inputClass} px-2 py-1 text-xs`;
  return (
    <tr className="bg-indigo-50/40">
      <td className={cell}>
        <input
          value={draft.label}
          onChange={(e) => setDraft({ ...draft, label: e.target.value })}
          placeholder="Metro"
          className={small}
        />
      </td>
      <td className={cell}>
        <div className="flex items-center gap-1">
          <input
            type="number"
            min={0}
            value={draft.fromMiles}
            onChange={(e) => setDraft({ ...draft, fromMiles: e.target.value })}
            placeholder="0"
            className={`${small} w-14`}
          />
          <span className="text-gray-400">–</span>
          <input
            type="number"
            min={1}
            value={draft.toMiles}
            onChange={(e) => setDraft({ ...draft, toMiles: e.target.value })}
            placeholder="∞"
            title="Leave blank for the band that catches everything further out"
            className={`${small} w-14`}
          />
        </div>
      </td>
      <td className={cell}>
        <input
          type="number"
          min={1}
          value={draft.minimumHours}
          onChange={(e) => setDraft({ ...draft, minimumHours: e.target.value })}
          className={`${small} w-14`}
        />
      </td>
      {VEHICLE_CLASSES.map((c) => (
        <td key={c} className={cell}>
          <input
            type="number"
            min={0}
            step={5}
            value={draft.rates[c] ?? ""}
            onChange={(e) => setDraft({ ...draft, rates: { ...draft.rates, [c]: e.target.value } })}
            placeholder="—"
            title="Blank means they do not run this size of car in this band"
            className={`${small} w-16 text-right`}
          />
        </td>
      ))}
      <td className={`${cell} whitespace-nowrap text-right`}>
        <button
          onClick={onSave}
          disabled={saving}
          className="text-xs font-medium text-indigo-600 hover:text-indigo-800 disabled:text-gray-400"
        >
          {saving ? "…" : saveLabel}
        </button>
        {onCancel && (
          <button
            onClick={onCancel}
            disabled={saving}
            className="ml-2 text-xs font-medium text-gray-500 hover:text-gray-800"
          >
            Cancel
          </button>
        )}
      </td>
    </tr>
  );
}

export function RateCardModal({
  affiliate,
  isAdmin,
  onClose,
}: {
  affiliate: Affiliate;
  isAdmin: boolean;
  onClose: () => void;
}) {
  const [zones, setZones] = useState<AffiliateZone[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [adding, setAdding] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setZones(await opsApi.zones(affiliate.id));
      setError(null);
    } catch (err) {
      setError(apiMessage(err));
    } finally {
      setLoading(false);
    }
  }, [affiliate.id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(work: () => Promise<unknown>) {
    setError(null);
    setSaving(true);
    try {
      await work();
      setEditingId(null);
      setAdding(null);
      await load();
    } catch (err) {
      setError(apiMessage(err));
    } finally {
      setSaving(false);
    }
  }

  const head = "px-1.5 py-2 text-[11px] font-medium text-gray-500";
  const cell = "border-t border-gray-100 px-1.5 py-1.5";

  return (
    <Modal title={`${affiliate.company} · rates`} onClose={onClose}>
      <div className="space-y-3">
        <p className="text-xs text-gray-500">
          Hourly, by distance from{" "}
          <span className="font-medium text-gray-700">{affiliate.baseAddress ?? "their base"}</span>.
          A blank rate means they do not run that car out there.
        </p>

        <ErrorNote message={error} />

        <div className="-mx-1 overflow-x-auto">
          <table className="w-full min-w-[34rem] border-collapse text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className={`${head} text-left`}>Band</th>
                <th className={`${head} text-left`}>Distance</th>
                <th className={`${head} text-left`}>Min</th>
                {VEHICLE_CLASSES.map((c) => (
                  <th key={c} className={`${head} text-right`}>
                    {CLASS_LABEL[c]}
                  </th>
                ))}
                {isAdmin && <th className={head} />}
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={9} className="px-2 py-6 text-center text-sm text-gray-500">
                    Loading…
                  </td>
                </tr>
              )}

              {!loading && zones.length === 0 && !adding && (
                <tr>
                  <td colSpan={9} className="px-2 py-6 text-center text-sm text-gray-500">
                    No rate card yet.
                  </td>
                </tr>
              )}

              {!loading &&
                zones.map((z) =>
                  editingId === z.id ? (
                    <DraftRow
                      key={z.id}
                      draft={draft}
                      setDraft={setDraft}
                      saving={saving}
                      saveLabel="Save"
                      onCancel={() => setEditingId(null)}
                      onSave={() => void run(() => opsApi.updateZone(z.id, toInput(draft)))}
                    />
                  ) : (
                    <tr key={z.id} className="hover:bg-gray-50">
                      <td className={`${cell} font-medium text-gray-900`}>{z.label}</td>
                      <td className={`${cell} whitespace-nowrap tabular-nums text-gray-600`}>
                        {bandRange(z)}
                      </td>
                      <td className={`${cell} tabular-nums text-gray-600`}>{z.minimumHours}h</td>
                      {VEHICLE_CLASSES.map((c) => {
                        const cents = z.rateCents?.[c];
                        return (
                          <td key={c} className={`${cell} text-right tabular-nums`}>
                            {typeof cents === "number" ? (
                              <span className="text-gray-800">{money(cents)}</span>
                            ) : (
                              <span className="text-gray-300" title="They do not run this car here">
                                —
                              </span>
                            )}
                          </td>
                        );
                      })}
                      {isAdmin && (
                        <td className={`${cell} whitespace-nowrap text-right`}>
                          <button
                            onClick={() => {
                              setAdding(null);
                              setEditingId(z.id);
                              setDraft(toDraft(z));
                            }}
                            className="text-xs font-medium text-indigo-600 hover:text-indigo-800"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => void run(() => opsApi.deleteZone(z.id))}
                            className="ml-2 text-xs font-medium text-red-600 hover:text-red-800"
                          >
                            Delete
                          </button>
                        </td>
                      )}
                    </tr>
                  )
                )}

              {adding && (
                <DraftRow
                  draft={adding}
                  setDraft={setAdding}
                  saving={saving}
                  saveLabel="Add"
                  onCancel={() => setAdding(null)}
                  onSave={() => void run(() => opsApi.createZone(affiliate.id, toInput(adding)))}
                />
              )}
            </tbody>
          </table>
        </div>

        <div className="flex justify-between pt-1">
          {isAdmin && !adding ? (
            <Button
              onClick={() => {
                setEditingId(null);
                // Start where the card currently stops, which is where the next
                // band almost always begins.
                const furthest = zones.reduce((m, z) => Math.max(m, z.toMiles ?? m), 0);
                setAdding({ ...EMPTY, fromMiles: String(furthest) });
              }}
            >
              Add band
            </Button>
          ) : (
            <span />
          )}
          <Button onClick={onClose}>Close</Button>
        </div>
      </div>
    </Modal>
  );
}

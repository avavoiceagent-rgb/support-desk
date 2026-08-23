// The reservations, as a table you can read down.
//
// Sorting is done by the server, not here. Reordering the fifty rows this
// screen happens to be holding would put the first "A" of the current page at
// the top of three hundred bookings and label the column alphabetical, which
// is a wrong answer delivered confidently — the worst kind. Clicking a heading
// re-asks the question and goes back to page one.
//
// Cancelled trips stay in the list. "Why was I charged for a trip I cancelled"
// is a real email and that record is exactly what answers it.

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  opsApi,
  toDateTimeInput,
  fromDateTimeInput,
  startOfDayIso,
  endOfDayIso,
  TRIP_STATUSES,
  type Affiliate,
  type Driver,
  type Trip,
  type TripSort,
  type TripStatus,
  type Vehicle,
} from "../../api/ops";
import { TripHistoryModal } from "./TripHistoryModal";
import { pastBookingWarning } from "../../lib/bookings";
import {
  Button,
  ErrorNote,
  Field,
  Modal,
  OPERATING_ZONE_LABEL,
  StatusPill,
  apiMessage,
  atTime,
  inputClass,
  onDate,
  when,
} from "./shared";

const PAGE_SIZE = 50;

const STATUS_LABEL: Record<TripStatus, string> = {
  SCHEDULED: "Scheduled",
  IN_PROGRESS: "On the road",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
  NO_SHOW: "No show",
};

function assignedTo(trip: Trip): string {
  if (trip.driver) return trip.driver.name;
  if (trip.affiliate) return trip.affiliate.company;
  return "—";
}

/** "230 Park Ave → JFK Terminal 4", short enough for a cell. */
function shortStop(address: string): string {
  return address.split(",")[0];
}

interface Sort {
  by: TripSort;
  dir: "asc" | "desc";
}

const COLUMNS: { key: TripSort | null; label: string; align?: "right"; className?: string }[] = [
  { key: "reference", label: "Ref" },
  { key: "pickupAt", label: `Pickup (${OPERATING_ZONE_LABEL})` },
  { key: "bookedHours", label: "Hrs", align: "right" },
  { key: "passengerName", label: "Passenger" },
  // Two columns rather than one "A → B": the eye scans a column of pickups
  // for the one it wants, and cannot do that when every cell starts with a
  // different address.
  { key: null, label: "From", className: "w-1/2" },
  { key: null, label: "To", className: "w-1/2" },
  { key: "vehicle", label: "Car" },
  { key: "driver", label: "Driver / partner" },
  { key: "status", label: "Status" },
];

function HeaderCell({
  column,
  sort,
  onSort,
}: {
  column: (typeof COLUMNS)[number];
  sort: Sort;
  onSort: (key: TripSort) => void;
}) {
  const active = column.key !== null && sort.by === column.key;
  const base = `whitespace-nowrap px-3 py-2 text-[11px] font-medium ${
    column.align === "right" ? "text-right" : "text-left"
  } ${column.className ?? ""}`;

  if (column.key === null) {
    return <th className={`${base} text-gray-500`}>{column.label}</th>;
  }
  return (
    <th className={`${base} p-0`}>
      <button
        onClick={() => onSort(column.key as TripSort)}
        className={`inline-flex items-center gap-1 rounded px-1 py-0.5 transition-colors ${
          active ? "text-indigo-700" : "text-gray-500 hover:text-gray-900"
        }`}
      >
        {column.label}
        <span className={active ? "" : "opacity-0 group-hover:opacity-40"}>
          {active ? (sort.dir === "asc" ? "▲" : "▼") : "▲"}
        </span>
      </button>
    </th>
  );
}

function Cell({
  children,
  title,
  className,
}: {
  children: ReactNode;
  title?: string;
  className?: string;
}) {
  return (
    <td className={`px-3 py-1.5 align-middle ${className ?? ""}`} title={title}>
      {children}
    </td>
  );
}

function TripEditor({
  trip,
  drivers,
  vehicles,
  affiliates,
  onClose,
  onSaved,
}: {
  trip: Trip;
  drivers: Driver[];
  vehicles: Vehicle[];
  affiliates: Affiliate[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [pickupAt, setPickupAt] = useState(toDateTimeInput(trip.pickupAt));
  const [bookedHours, setBookedHours] = useState(String(trip.bookedHours));
  const [driverId, setDriverId] = useState(trip.driverId ?? "");
  const [vehicleId, setVehicleId] = useState(trip.vehicleId ?? "");
  const [affiliateId, setAffiliateId] = useState(trip.affiliateId ?? "");
  const [status, setStatus] = useState<TripStatus>(trip.status);
  const [notes, setNotes] = useState(trip.notes ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await opsApi.updateTrip(trip.id, {
        pickupAt: fromDateTimeInput(pickupAt),
        bookedHours: Number(bookedHours),
        driverId: driverId || null,
        vehicleId: vehicleId || null,
        affiliateId: affiliateId || null,
        status,
        notes: notes.trim() || null,
      });
      onSaved();
    } catch (err) {
      setError(apiMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={`${trip.reference} · ${trip.passengerName}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <div className="rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-600">
          <p>
            {trip.pickupAddress} → {trip.dropoffAddress}
          </p>
          <p className="mt-1">
            {trip.vehicleClass}
            {trip.passengerCount != null && ` · ${trip.passengerCount} passengers`}
            {trip.luggageCount != null && ` · ${trip.luggageCount} bags`}
            {trip.flightNumber && ` · flight ${trip.flightNumber}`}
          </p>
          {trip.bookerEmail && <p className="mt-1">Booked by {trip.bookerName ?? trip.bookerEmail}</p>}
        </div>

        {pastBookingWarning(trip, trip.reference) && (
          <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            {pastBookingWarning(trip, trip.reference)}
          </p>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={`Pickup (${OPERATING_ZONE_LABEL})`}>
            <input
              type="datetime-local"
              value={pickupAt}
              onChange={(e) => setPickupAt(e.target.value)}
              className={inputClass}
              required
            />
          </Field>
          <Field label="Hours booked">
            <input
              type="number"
              min={1}
              value={bookedHours}
              onChange={(e) => setBookedHours(e.target.value)}
              className={inputClass}
              required
            />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Driver">
            <select value={driverId} onChange={(e) => setDriverId(e.target.value)} className={inputClass}>
              <option value="">Unassigned</option>
              {drivers
                .filter((d) => d.active || d.id === driverId)
                .map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                    {d.active ? "" : " (deactivated)"}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Car">
            <select value={vehicleId} onChange={(e) => setVehicleId(e.target.value)} className={inputClass}>
              <option value="">None</option>
              {vehicles
                .filter((v) => v.active || v.id === vehicleId)
                .map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label} — {v.class}
                  </option>
                ))}
            </select>
          </Field>
        </div>

        <Field label="Partner" hint="For work farmed out rather than driven by us.">
          <select value={affiliateId} onChange={(e) => setAffiliateId(e.target.value)} className={inputClass}>
            <option value="">None</option>
            {affiliates
              .filter((a) => a.active || a.id === affiliateId)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.company}
                  {a.active ? "" : " (deactivated)"}
                </option>
              ))}
          </select>
        </Field>

        <Field label="Status">
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as TripStatus)}
            className={inputClass}
          >
            {TRIP_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Notes">
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={inputClass} />
        </Field>

        <ErrorNote message={error} />

        <div className="flex justify-end gap-2 pt-1">
          <Button onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button kind="primary" type="submit" disabled={saving}>
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function ReservationsTab({
  drivers,
  vehicles,
  affiliates,
  isAdmin,
}: {
  drivers: Driver[];
  vehicles: Vehicle[];
  affiliates: Affiliate[];
  isAdmin: boolean;
}) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [status, setStatus] = useState("");
  const [driverId, setDriverId] = useState("");
  const [affiliateId, setAffiliateId] = useState("");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<Sort>({ by: "pickupAt", dir: "desc" });
  const [offset, setOffset] = useState(0);

  const [trips, setTrips] = useState<Trip[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Trip | null>(null);
  const [historyFor, setHistoryFor] = useState<Trip | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await opsApi.trips({
        from: from ? startOfDayIso(from) : undefined,
        to: to ? endOfDayIso(to) : undefined,
        status: status || undefined,
        driverId: driverId || undefined,
        affiliateId: affiliateId || undefined,
        q: q.trim() || undefined,
        sort: sort.by,
        dir: sort.dir,
        limit: PAGE_SIZE,
        offset,
      });
      setTrips(result.trips);
      setTotal(result.total);
    } catch (err) {
      setTrips([]);
      setTotal(0);
      setError(apiMessage(err));
    } finally {
      setLoading(false);
    }
  }, [from, to, status, driverId, affiliateId, q, sort, offset]);

  useEffect(() => {
    void load();
  }, [load]);

  // Any change to the filters or the sort goes back to page one. Staying on
  // page four of a result set that no longer has four pages shows an empty
  // screen, which reads as "no matches".
  function onFilter<T>(set: (v: T) => void) {
    return (v: T) => {
      setOffset(0);
      set(v);
    };
  }

  function onSort(key: TripSort) {
    setOffset(0);
    setSort((current) =>
      current.by === key
        ? { by: key, dir: current.dir === "asc" ? "desc" : "asc" }
        : // Time reads newest-first; everything else reads A to Z.
          { by: key, dir: key === "pickupAt" ? "desc" : "asc" }
    );
  }

  const first = total === 0 ? 0 : offset + 1;
  const last = Math.min(offset + PAGE_SIZE, total);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-gray-200 bg-white px-5 py-4 shadow-sm">
        <div className="min-w-[13rem]">
          <Field label="Search" hint="Reference, passenger or booker email">
            <input
              value={q}
              onChange={(e) => onFilter(setQ)(e.target.value)}
              placeholder="T-10432, Costa, ana@…"
              className={inputClass}
            />
          </Field>
        </div>
        <div>
          <Field label="From">
            <input
              type="date"
              value={from}
              onChange={(e) => onFilter(setFrom)(e.target.value)}
              className={inputClass}
            />
          </Field>
        </div>
        <div>
          <Field label="To">
            <input
              type="date"
              value={to}
              onChange={(e) => onFilter(setTo)(e.target.value)}
              className={inputClass}
            />
          </Field>
        </div>
        <div>
          <Field label="Status">
            <select
              value={status}
              onChange={(e) => onFilter(setStatus)(e.target.value)}
              className={inputClass}
            >
              <option value="">Any</option>
              {TRIP_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div>
          <Field label="Driver">
            <select
              value={driverId}
              onChange={(e) => onFilter(setDriverId)(e.target.value)}
              className={inputClass}
            >
              <option value="">Anyone</option>
              {drivers.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div>
          <Field label="Partner">
            <select
              value={affiliateId}
              onChange={(e) => onFilter(setAffiliateId)(e.target.value)}
              className={inputClass}
            >
              <option value="">Any</option>
              {affiliates.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.company}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="ml-auto">
          <Button
            onClick={() => {
              setOffset(0);
              setFrom("");
              setTo("");
              setStatus("");
              setDriverId("");
              setAffiliateId("");
              setQ("");
              setSort({ by: "pickupAt", dir: "desc" });
            }}
          >
            Clear filters
          </Button>
        </div>
      </div>

      <ErrorNote message={error} />

      <section className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-5 py-3">
          <h2 className="text-sm font-semibold text-gray-900">
            {total === 0 ? "Reservations" : `Reservations · ${first}–${last} of ${total}`}
          </h2>
          {total > PAGE_SIZE && (
            <span className="flex gap-2">
              <Button onClick={() => setOffset(Math.max(offset - PAGE_SIZE, 0))} disabled={offset === 0}>
                Previous
              </Button>
              <Button onClick={() => setOffset(offset + PAGE_SIZE)} disabled={last >= total}>
                Next
              </Button>
            </span>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[70rem] border-collapse text-sm">
            <thead className="border-b border-gray-200 bg-gray-50">
              <tr>
                {COLUMNS.map((c) => (
                  <HeaderCell key={c.label} column={c} sort={sort} onSort={onSort} />
                ))}
                <th className="whitespace-nowrap px-3 py-2 text-right text-[11px] font-medium text-gray-500">
                  History
                </th>
                {isAdmin && <th className="w-px px-3 py-2" />}
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={COLUMNS.length + 2} className="px-5 py-8 text-center text-sm text-gray-500">
                    Loading…
                  </td>
                </tr>
              )}

              {!loading && trips.length === 0 && (
                <tr>
                  <td colSpan={COLUMNS.length + 2} className="px-5 py-8 text-center text-sm text-gray-500">
                    No reservations match those filters.
                  </td>
                </tr>
              )}

              {!loading &&
                trips.map((t) => (
                  <tr key={t.id} className="border-b border-gray-100 last:border-b-0 hover:bg-indigo-50/40">
                    <Cell className="whitespace-nowrap font-medium tabular-nums text-gray-900">
                      {t.reference}
                    </Cell>
                    <Cell className="whitespace-nowrap tabular-nums text-gray-700" title={when(t.pickupAt)}>
                      <span className="text-gray-500">{onDate(t.pickupAt)}</span>{" "}
                      {atTime(t.pickupAt)}
                    </Cell>
                    <Cell className="whitespace-nowrap text-right tabular-nums text-gray-600">
                      {t.bookedHours}h
                    </Cell>
                    <Cell className="whitespace-nowrap text-gray-800">
                      {t.passengerName}
                      {t.passengerCount != null && (
                        <span className="ml-1 text-[11px] text-gray-400">{t.passengerCount}p</span>
                      )}
                    </Cell>
                    <Cell className="max-w-0 truncate text-gray-600" title={t.pickupAddress}>
                      {shortStop(t.pickupAddress)}
                    </Cell>
                    <Cell className="max-w-0 truncate text-gray-600" title={t.dropoffAddress}>
                      {shortStop(t.dropoffAddress)}
                    </Cell>
                    <Cell className="whitespace-nowrap text-gray-600">
                      {t.vehicle?.label ?? (
                        <span className="text-gray-400">{t.vehicleClass.toLowerCase()}</span>
                      )}
                    </Cell>
                    <Cell
                      className="whitespace-nowrap text-gray-600"
                      title={
                        t.farmOutReason === "OUT_OF_AREA"
                          ? "Farmed out — outside our service area"
                          : t.farmOutReason === "NO_VEHICLE"
                            ? "Farmed out — no car free"
                            : undefined
                      }
                    >
                      {assignedTo(t)}
                      {t.affiliate && <span className="ml-1 text-[11px] text-violet-600">partner</span>}
                    </Cell>
                    <Cell className="whitespace-nowrap">
                      <StatusPill status={t.status} />
                    </Cell>
                    <Cell className="whitespace-nowrap text-right">
                      <button
                        onClick={() => setHistoryFor(t)}
                        className="text-xs font-medium text-gray-500 transition-colors hover:text-indigo-700"
                      >
                        History
                      </button>
                    </Cell>
                    {isAdmin && (
                      <Cell className="whitespace-nowrap text-right">
                        <button
                          onClick={() => setEditing(t)}
                          className="text-xs font-medium text-indigo-600 transition-colors hover:text-indigo-800"
                        >
                          Edit
                        </button>
                      </Cell>
                    )}
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </section>

      {historyFor && <TripHistoryModal trip={historyFor} onClose={() => setHistoryFor(null)} />}

      {editing && (
        <TripEditor
          trip={editing}
          drivers={drivers}
          vehicles={vehicles}
          affiliates={affiliates}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

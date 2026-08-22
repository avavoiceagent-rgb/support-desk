// Browsing the reservations, and changing one.
//
// Cancelled trips are in the list rather than filtered out: "why was I charged
// for a trip I cancelled" is a real email, and the record behind it is exactly
// what somebody working that ticket needs to find.
//
// The one rule the server enforces on a change is that a driver cannot be in
// two places at once. When it refuses it says who is on what and when, and
// that sentence is shown here word for word — replacing it with "could not
// save" would throw away the only part a dispatcher can act on.

import { useCallback, useEffect, useState, type FormEvent } from "react";
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
  type TripStatus,
  type Vehicle,
} from "../../api/ops";
import {
  Button,
  Card,
  Empty,
  ErrorNote,
  Field,
  Modal,
  StatusPill,
  apiMessage,
  inputClass,
  shortAddress,
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
  if (trip.driver) return `${trip.driver.name}${trip.vehicle ? ` · ${trip.vehicle.label}` : ""}`;
  if (trip.affiliate) return `${trip.affiliate.company} (partner)`;
  return "Unassigned";
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

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Pickup">
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
  const [offset, setOffset] = useState(0);

  const [trips, setTrips] = useState<Trip[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Trip | null>(null);

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
  }, [from, to, status, driverId, affiliateId, q, offset]);

  useEffect(() => {
    void load();
  }, [load]);

  // Any change to the filters puts us back on the first page. Staying on page
  // four of a result set that no longer has four pages shows an empty screen
  // and looks like "no matches".
  function filterSetter<T>(set: (v: T) => void) {
    return (v: T) => {
      setOffset(0);
      set(v);
    };
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
              onChange={(e) => filterSetter(setQ)(e.target.value)}
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
              onChange={(e) => filterSetter(setFrom)(e.target.value)}
              className={inputClass}
            />
          </Field>
        </div>
        <div>
          <Field label="To">
            <input
              type="date"
              value={to}
              onChange={(e) => filterSetter(setTo)(e.target.value)}
              className={inputClass}
            />
          </Field>
        </div>
        <div>
          <Field label="Status">
            <select
              value={status}
              onChange={(e) => filterSetter(setStatus)(e.target.value)}
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
              onChange={(e) => filterSetter(setDriverId)(e.target.value)}
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
              onChange={(e) => filterSetter(setAffiliateId)(e.target.value)}
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
            }}
          >
            Clear filters
          </Button>
        </div>
      </div>

      <ErrorNote message={error} />

      <Card
        title={total === 0 ? "Reservations" : `Reservations · ${first}–${last} of ${total}`}
        action={
          total > PAGE_SIZE ? (
            <span className="flex gap-2">
              <Button onClick={() => setOffset(Math.max(offset - PAGE_SIZE, 0))} disabled={offset === 0}>
                Previous
              </Button>
              <Button onClick={() => setOffset(offset + PAGE_SIZE)} disabled={last >= total}>
                Next
              </Button>
            </span>
          ) : undefined
        }
      >
        {loading && <Empty>Loading…</Empty>}
        {!loading && trips.length === 0 && <Empty>No reservations match those filters.</Empty>}
        {!loading &&
          trips.map((t) => (
            <div key={t.id} className="border-t border-gray-100 px-5 py-3 first:border-t-0">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold tabular-nums text-gray-900">{t.reference}</span>
                    <StatusPill status={t.status} />
                    <span className="text-sm text-gray-700">{when(t.pickupAt)}</span>
                    <span className="text-xs text-gray-500">{t.bookedHours}h</span>
                  </div>
                  <p className="mt-1 text-xs text-gray-600">
                    {t.passengerName}
                    {t.passengerCount != null && ` · ${t.passengerCount} pax`}
                    {t.luggageCount != null && ` · ${t.luggageCount} bags`} · {t.vehicleClass}
                  </p>
                  <p className="mt-0.5 text-xs text-gray-500">
                    {shortAddress(t.pickupAddress)} → {shortAddress(t.dropoffAddress)}
                  </p>
                  <p className="mt-0.5 text-xs text-gray-500">
                    {assignedTo(t)}
                    {t.farmOutReason && ` · ${t.farmOutReason === "OUT_OF_AREA" ? "outside our area" : "no car free"}`}
                  </p>
                </div>
                {isAdmin && (
                  <div className="shrink-0">
                    <Button onClick={() => setEditing(t)}>Edit</Button>
                  </div>
                )}
              </div>
            </div>
          ))}
      </Card>

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

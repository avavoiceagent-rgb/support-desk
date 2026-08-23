// Turning an agreed booking into a reservation.
//
// A button somebody presses, not something that happens on Send. Adam's first
// reply is usually a question — "are you booking for yourself or for someone
// else?" — and a reservation made off the back of a question is a car held for
// a booking nobody agreed to.
//
// The form opens on what the draft worked out, but everything is editable and
// what the person submits is what gets written. Those values came from a model
// reading an email; a booking made from that without anybody checking is the
// confident wrong answer this desk exists to avoid. Where the draft
// established nothing the field is blank, because a plausible default is
// something a tired reader clicks past.

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../api/client";
import type { Trip, VehicleClass } from "../api/ops";
import { VEHICLE_CLASSES, OPERATING_ZONE_LABEL, opsApi } from "../api/ops";
import { when, toDateTimeInput, fromDateTimeInput } from "../lib/time";
import { useAuth } from "../hooks/useAuth";

/** A booking this email names by reference. */
interface QuotedTrip {
  id: string;
  reference: string;
  pickupAt: string;
  bookedHours: number;
  vehicleClass: VehicleClass;
  status: string;
  passengerName: string;
  pickupAddress: string;
  dropoffAddress: string;
  driverName: string | null;
  affiliateCompany: string | null;
}

interface DraftFacts {
  passengerName: string | null;
  passengerPhone: string | null;
  bookerName: string | null;
  bookerEmail: string | null;
  pickupAddress: string | null;
  dropoffAddress: string | null;
  stops: string[];
  pickupAtLocal: string | null;
  vehicleClass: VehicleClass | null;
  passengerCount: number | null;
  luggageCount: number | null;
  flightNumber: string | null;
}

const CLASS_LABEL: Record<VehicleClass, string> = {
  SEDAN: "Sedan",
  SUV: "SUV",
  VAN: "Van",
  SPRINTER: "Sprinter",
};

const field =
  "w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500";

function Label({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <span className="mb-1 block text-xs font-medium text-gray-600">
      {children}
      {hint && <span className="ml-1 font-normal text-gray-400">{hint}</span>}
    </span>
  );
}

export function ReservationPanel({ ticketId }: { ticketId: string }) {
  const { user } = useAuth();
  const isAdmin = user?.role === "ADMIN";

  const [trip, setTrip] = useState<Trip | null>(null);
  const [suggested, setSuggested] = useState<DraftFacts | null>(null);
  const [quoted, setQuoted] = useState<QuotedTrip[]>([]);
  const [unresolved, setUnresolved] = useState<string[]>([]);
  const [changing, setChanging] = useState<QuotedTrip | null>(null);
  const [change, setChange] = useState({ pickupAtLocal: "", bookedHours: "" });
  const [changed, setChanged] = useState<string | null>(null);
  const [forceNew, setForceNew] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState({
    passengerName: "",
    pickupAddress: "",
    dropoffAddress: "",
    pickupAtLocal: "",
    bookedHours: "3",
    vehicleClass: "" as VehicleClass | "",
    passengerCount: "",
    luggageCount: "",
    flightNumber: "",
    notes: "",
  });

  const load = useCallback(async () => {
    try {
      const r = await api.get<{
        trip: Trip | null;
        suggested: DraftFacts | null;
        quoted: QuotedTrip[];
        unresolved: string[];
      }>(`/tickets/${ticketId}/reservation`);
      setTrip(r.trip);
      setSuggested(r.suggested);
      setQuoted(r.quoted ?? []);
      setUnresolved(r.unresolved ?? []);
    } catch {
      // A ticket without a reservation is the normal case, and a panel that
      // shouts about a failed background read would be noise on every ticket.
      setTrip(null);
    } finally {
      setLoaded(true);
    }
  }, [ticketId]);

  useEffect(() => {
    setLoaded(false);
    setOpen(false);
    setChanging(null);
    setChanged(null);
    setForceNew(false);
    void load();
  }, [load]);

  function startChange(q: QuotedTrip) {
    setError(null);
    setChanged(null);
    setChange({ pickupAtLocal: toDateTimeInput(q.pickupAt), bookedHours: String(q.bookedHours) });
    setChanging(q);
  }

  async function saveChange(e: FormEvent) {
    e.preventDefault();
    if (!changing) return;
    setError(null);
    setSaving(true);
    try {
      // The same endpoint the Reservations screen uses, so the double-booking
      // refusal and the trip's own history apply to a change made from here
      // exactly as they do to one made there.
      const { trip: updated } = await opsApi.updateTrip(changing.id, {
        pickupAt: fromDateTimeInput(change.pickupAtLocal),
        bookedHours: Number(change.bookedHours),
      });
      setChanged(`${updated.reference} moved to ${when(updated.pickupAt)}.`);
      setChanging(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not change the booking.");
    } finally {
      setSaving(false);
    }
  }

  function startForm() {
    setError(null);
    setForm({
      passengerName: suggested?.passengerName ?? "",
      pickupAddress: suggested?.pickupAddress ?? "",
      dropoffAddress: suggested?.dropoffAddress ?? "",
      pickupAtLocal: suggested?.pickupAtLocal ?? "",
      bookedHours: "3",
      vehicleClass: suggested?.vehicleClass ?? "",
      passengerCount: suggested?.passengerCount?.toString() ?? "",
      luggageCount: suggested?.luggageCount?.toString() ?? "",
      flightNumber: suggested?.flightNumber ?? "",
      notes: "",
    });
    setOpen(true);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const { trip: made } = await api.post<{ trip: Trip }>(`/tickets/${ticketId}/reservation`, {
        ...form,
        bookedHours: Number(form.bookedHours),
        passengerCount: form.passengerCount === "" ? null : Number(form.passengerCount),
        luggageCount: form.luggageCount === "" ? null : Number(form.luggageCount),
        flightNumber: form.flightNumber.trim() || null,
        notes: form.notes.trim() || null,
        bookerName: suggested?.bookerName ?? null,
        bookerEmail: suggested?.bookerEmail ?? null,
        passengerPhone: suggested?.passengerPhone ?? null,
        stops: suggested?.stops ?? [],
      });
      setTrip(made);
      setOpen(false);
    } catch (err) {
      // The server's refusals here name the reservation that already exists.
      setError(err instanceof ApiError ? err.message : "Could not create the reservation.");
    } finally {
      setSaving(false);
    }
  }

  if (!loaded) return null;

  if (trip) {
    return (
      <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5">
        <p className="text-xs font-medium uppercase tracking-wide text-emerald-700">Reservation</p>
        <p className="mt-1 text-sm font-semibold text-gray-900">{trip.reference}</p>
        <p className="text-xs text-gray-600">
          {when(trip.pickupAt)} · {trip.bookedHours}h · {CLASS_LABEL[trip.vehicleClass]}
        </p>
        <p className="mt-0.5 text-xs text-gray-500">
          {trip.driver?.name ?? trip.affiliate?.company ?? "Nobody assigned yet"}
        </p>
        <Link
          to="/operations"
          className="mt-1.5 inline-block text-xs font-medium text-indigo-600 hover:text-indigo-800"
        >
          Open in Operations →
        </Link>
      </div>
    );
  }

  // The email names a booking, so this is a change to that one — not a new
  // one beside it. Create reservation is demoted to an escape hatch rather
  // than removed, because the desk can be wrong about which trip is meant.
  if (quoted.length > 0 && !forceNew) {
    return (
      <div className="mt-3 space-y-2">
        {changed && (
          <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
            {changed}
          </p>
        )}

        <div className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2.5">
          <p className="text-xs font-medium uppercase tracking-wide text-sky-700">
            {quoted.length === 1 ? "This is about an existing booking" : "This is about existing bookings"}
          </p>

          {quoted.map((q) => (
            <div key={q.id} className="mt-2 border-t border-sky-200/70 pt-2 first:mt-1.5 first:border-t-0 first:pt-0">
              <p className="text-sm font-semibold text-gray-900">{q.reference}</p>
              <p className="text-xs text-gray-700">
                {when(q.pickupAt)} · {q.bookedHours}h · {CLASS_LABEL[q.vehicleClass]}
              </p>
              <p className="text-xs text-gray-500">
                {q.passengerName} · {q.driverName ?? q.affiliateCompany ?? "Nobody assigned"}
              </p>

              {changing?.id === q.id ? (
                <form onSubmit={saveChange} className="mt-2 space-y-2">
                  <label className="block">
                    <Label hint={`(${OPERATING_ZONE_LABEL})`}>New pickup</Label>
                    <input
                      type="datetime-local"
                      value={change.pickupAtLocal}
                      onChange={(e) => setChange({ ...change, pickupAtLocal: e.target.value })}
                      className={field}
                      required
                    />
                  </label>
                  <label className="block">
                    <Label>Hours</Label>
                    <input
                      type="number"
                      min={1}
                      value={change.bookedHours}
                      onChange={(e) => setChange({ ...change, bookedHours: e.target.value })}
                      className={field}
                      required
                    />
                  </label>
                  {error && (
                    <p className="rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs text-red-800">
                      {error}
                    </p>
                  )}
                  <div className="flex gap-2">
                    <button
                      type="submit"
                      disabled={saving}
                      className="flex-1 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:bg-indigo-300"
                    >
                      {saving ? "Saving…" : "Save the change"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setChanging(null)}
                      disabled={saving}
                      className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:border-gray-400"
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              ) : isAdmin ? (
                <button
                  onClick={() => startChange(q)}
                  className="mt-1.5 text-xs font-medium text-indigo-600 hover:text-indigo-800"
                >
                  Change this booking →
                </button>
              ) : (
                <p className="mt-1.5 text-[11px] text-gray-500">
                  Ask an admin to change it, or open it on the Operations tab.
                </p>
              )}
            </div>
          ))}
        </div>

        {unresolved.length > 0 && (
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
            They also quoted {unresolved.join(", ")}, which matches nothing on file — worth checking
            whether it is a typo before replying.
          </p>
        )}

        <button
          onClick={() => setForceNew(true)}
          className="text-[11px] text-gray-400 underline-offset-2 hover:text-gray-600 hover:underline"
        >
          Not a change — create a new reservation instead
        </button>
      </div>
    );
  }

  if (!open) {
    return (
      <div className="mt-3">
        <button
          onClick={startForm}
          className="w-full rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-700"
        >
          Create reservation
        </button>
        <p className="mt-1 text-[11px] text-gray-400">
          {suggested
            ? "Pre-filled from the draft. Check it before saving."
            : "Nothing on file for this ticket — you'll need to fill it in."}
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="mt-3 space-y-2.5 rounded-lg border border-gray-200 p-3">
      <p className="text-xs font-medium uppercase tracking-wide text-gray-400">New reservation</p>

      <label className="block">
        <Label>Passenger</Label>
        <input
          value={form.passengerName}
          onChange={(e) => setForm({ ...form, passengerName: e.target.value })}
          className={field}
          required
        />
      </label>

      <label className="block">
        <Label>Pickup</Label>
        <input
          value={form.pickupAddress}
          onChange={(e) => setForm({ ...form, pickupAddress: e.target.value })}
          className={field}
          required
        />
      </label>

      <label className="block">
        <Label>Dropoff</Label>
        <input
          value={form.dropoffAddress}
          onChange={(e) => setForm({ ...form, dropoffAddress: e.target.value })}
          className={field}
          required
        />
      </label>

      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <Label hint={`(${OPERATING_ZONE_LABEL})`}>When</Label>
          <input
            type="datetime-local"
            value={form.pickupAtLocal}
            onChange={(e) => setForm({ ...form, pickupAtLocal: e.target.value })}
            className={field}
            required
          />
        </label>
        <label className="block">
          <Label>Hours</Label>
          <input
            type="number"
            min={1}
            value={form.bookedHours}
            onChange={(e) => setForm({ ...form, bookedHours: e.target.value })}
            className={field}
            required
          />
        </label>
      </div>

      <label className="block">
        <Label>Car</Label>
        <select
          value={form.vehicleClass}
          onChange={(e) => setForm({ ...form, vehicleClass: e.target.value as VehicleClass })}
          className={field}
          required
        >
          <option value="">Choose…</option>
          {VEHICLE_CLASSES.map((c) => (
            <option key={c} value={c}>
              {CLASS_LABEL[c]}
            </option>
          ))}
        </select>
      </label>

      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <Label>Passengers</Label>
          <input
            type="number"
            min={1}
            value={form.passengerCount}
            onChange={(e) => setForm({ ...form, passengerCount: e.target.value })}
            className={field}
          />
        </label>
        <label className="block">
          <Label>Bags</Label>
          <input
            type="number"
            min={0}
            value={form.luggageCount}
            onChange={(e) => setForm({ ...form, luggageCount: e.target.value })}
            className={field}
          />
        </label>
      </div>

      {error && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs text-red-800">
          {error}
        </p>
      )}

      <div className="flex gap-2 pt-0.5">
        <button
          type="submit"
          disabled={saving}
          className="flex-1 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:bg-indigo-300"
        >
          {saving ? "Saving…" : "Create"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          disabled={saving}
          className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:border-gray-400"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

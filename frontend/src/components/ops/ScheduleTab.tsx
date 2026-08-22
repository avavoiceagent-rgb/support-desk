// One driver's roster, and what is booked inside it.
//
// A list by driver rather than a week grid, because the question a dispatcher
// actually asks is "is Marco free on Thursday?" — one person, one stretch of
// time. Trips sit inside the shift that covers them; a trip no shift covers is
// pulled out and shown in amber at the top, never folded into the nearest one.

import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  opsApi,
  toDateInput,
  toDateTimeInput,
  fromDateTimeInput,
  startOfDayIso,
  endOfDayIso,
  type Driver,
  type DriverSchedule,
  type Shift,
  type Trip,
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
  onDate,
  shortAddress,
  span,
  when,
} from "./shared";

function addDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return toDateInput(d);
}

function TripLine({ trip }: { trip: Trip }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-gray-100 py-2 pl-4 text-sm first:border-t-0">
      <span className="font-medium tabular-nums text-gray-900">{trip.reference}</span>
      <span className="text-gray-700">{when(trip.pickupAt)}</span>
      <span className="text-gray-500">
        {trip.bookedHours}h · {trip.passengerName}
      </span>
      <span className="text-gray-500">
        {shortAddress(trip.pickupAddress)} → {shortAddress(trip.dropoffAddress)}
      </span>
      <StatusPill status={trip.status} />
    </div>
  );
}

function ShiftBlock({
  shift,
  isAdmin,
  onEdit,
}: {
  shift: Shift;
  isAdmin: boolean;
  onEdit: () => void;
}) {
  const hours = shift.trips.reduce((sum, t) => sum + t.bookedHours, 0);
  return (
    <div className="border-t border-gray-100 px-5 py-3 first:border-t-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-sm font-semibold text-gray-900">{span(shift.startsAt, shift.endsAt)}</span>
          {shift.unavailable ? (
            <span className="rounded-full bg-gray-200 px-2 py-0.5 text-[11px] font-medium text-gray-700">
              Unavailable{shift.reason ? ` · ${shift.reason}` : ""}
            </span>
          ) : (
            <span className="text-xs text-gray-500">
              {shift.vehicle ? shift.vehicle.label : "No car assigned"}
              {shift.trips.length > 0 && ` · ${shift.trips.length} booked (${hours}h)`}
            </span>
          )}
        </div>
        {isAdmin && (
          <button
            onClick={onEdit}
            className="text-xs font-medium text-indigo-600 transition-colors hover:text-indigo-800"
          >
            Edit
          </button>
        )}
      </div>
      {/* A driver marked unavailable who still has work on the books. The seed no
          longer produces this, but an admin can create it in one click by
          blocking out a shift after the trips were assigned, and it is precisely
          the kind of thing that should not sit quietly in a list. */}
      {shift.unavailable && shift.trips.length > 0 && (
        <p className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
          {shift.trips.length === 1 ? "A trip is" : `${shift.trips.length} trips are`} still booked
          inside this shift, but {shift.reason ? shift.reason.toLowerCase() : "the driver"} takes them
          off the road. Reassign the work or clear the block.
        </p>
      )}
      {shift.trips.length > 0 && <div className="mt-1">{shift.trips.map((t) => <TripLine key={t.id} trip={t} />)}</div>}
    </div>
  );
}

interface EditorState {
  shift: Shift | null;
  driverId: string;
}

function ShiftEditor({
  state,
  vehicles,
  onClose,
  onSaved,
}: {
  state: EditorState;
  vehicles: Vehicle[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const existing = state.shift;
  const [startsAt, setStartsAt] = useState(
    existing ? toDateTimeInput(existing.startsAt) : toDateTimeInput(new Date())
  );
  const [endsAt, setEndsAt] = useState(
    existing
      ? toDateTimeInput(existing.endsAt)
      : toDateTimeInput(new Date(Date.now() + 8 * 3_600_000))
  );
  const [vehicleId, setVehicleId] = useState(existing?.vehicle?.id ?? "");
  const [unavailable, setUnavailable] = useState(existing?.unavailable ?? false);
  const [reason, setReason] = useState(existing?.reason ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const body = {
        startsAt: fromDateTimeInput(startsAt),
        endsAt: fromDateTimeInput(endsAt),
        vehicleId: vehicleId || null,
        unavailable,
        reason: reason.trim() || null,
      };
      if (existing) await opsApi.updateShift(existing.id, body);
      else await opsApi.createShift({ driverId: state.driverId, ...body });
      onSaved();
    } catch (err) {
      setError(apiMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!existing) return;
    setError(null);
    setSaving(true);
    try {
      await opsApi.deleteShift(existing.id);
      onSaved();
    } catch (err) {
      setError(apiMessage(err));
    } finally {
      setSaving(false);
    }
  }

  const booked = existing?.trips.length ?? 0;

  return (
    <Modal title={existing ? "Edit shift" : "Add shift"} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Starts">
            <input
              type="datetime-local"
              value={startsAt}
              onChange={(e) => setStartsAt(e.target.value)}
              className={inputClass}
              required
            />
          </Field>
          <Field label="Ends" hint="A shift can run up to 24 hours.">
            <input
              type="datetime-local"
              value={endsAt}
              onChange={(e) => setEndsAt(e.target.value)}
              className={inputClass}
              required
            />
          </Field>
        </div>

        <Field label="Car">
          <select value={vehicleId} onChange={(e) => setVehicleId(e.target.value)} className={inputClass}>
            <option value="">No car assigned</option>
            {vehicles
              .filter((v) => v.active || v.id === vehicleId)
              .map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label} — {v.makeModel}
                  {v.active ? "" : " (inactive)"}
                </option>
              ))}
          </select>
        </Field>

        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={unavailable}
            onChange={(e) => setUnavailable(e.target.checked)}
            className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
          />
          Marked unavailable (time off, not a working shift)
        </label>

        {unavailable && (
          <Field label="Reason">
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Vacation, sick, training…"
              className={inputClass}
            />
          </Field>
        )}

        {booked > 0 && (
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            {booked === 1 ? "1 trip is" : `${booked} trips are`} booked inside this shift. Deleting it
            does not cancel {booked === 1 ? "it" : "them"} — {booked === 1 ? "it" : "they"} will show as
            uncovered.
          </p>
        )}

        <ErrorNote message={error} />

        <div className="flex items-center justify-between gap-2 pt-1">
          {existing ? (
            <Button kind="danger" onClick={() => void remove()} disabled={saving}>
              Delete shift
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button kind="primary" type="submit" disabled={saving}>
              {saving ? "Saving…" : existing ? "Save changes" : "Add shift"}
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

export function ScheduleTab({
  drivers,
  vehicles,
  isAdmin,
}: {
  drivers: Driver[];
  vehicles: Vehicle[];
  isAdmin: boolean;
}) {
  const [driverId, setDriverId] = useState("");
  const [from, setFrom] = useState(() => addDays(0));
  const [to, setTo] = useState(() => addDays(14));
  const [schedule, setSchedule] = useState<DriverSchedule | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);

  useEffect(() => {
    if (!driverId && drivers.length > 0) setDriverId(drivers[0].id);
  }, [drivers, driverId]);

  const load = useCallback(async () => {
    if (!driverId) return;
    setLoading(true);
    setError(null);
    try {
      setSchedule(await opsApi.schedule(driverId, { from: startOfDayIso(from), to: endOfDayIso(to) }));
    } catch (err) {
      setSchedule(null);
      setError(apiMessage(err));
    } finally {
      setLoading(false);
    }
  }, [driverId, from, to]);

  useEffect(() => {
    void load();
  }, [load]);

  const driver = drivers.find((d) => d.id === driverId);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-gray-200 bg-white px-5 py-4 shadow-sm">
        <div className="min-w-[14rem]">
          <Field label="Driver">
            <select value={driverId} onChange={(e) => setDriverId(e.target.value)} className={inputClass}>
              {drivers.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                  {d.active ? "" : " (inactive)"}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div>
          <Field label="From">
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={inputClass} />
          </Field>
        </div>
        <div>
          <Field label="To">
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={inputClass} />
          </Field>
        </div>
        <div className="ml-auto flex gap-2">
          <Button onClick={() => { setFrom(addDays(0)); setTo(addDays(14)); }}>Next 2 weeks</Button>
          {isAdmin && driverId && (
            <Button kind="primary" onClick={() => setEditor({ shift: null, driverId })}>
              Add shift
            </Button>
          )}
        </div>
      </div>

      {driver && (
        <p className="px-1 text-xs text-gray-500">
          {driver.phone}
          {driver.defaultVehicle && ` · usually ${driver.defaultVehicle.label}`}
          {driver.licenceNumber && ` · licence ${driver.licenceNumber}`}
          {!driver.active && " · deactivated"}
        </p>
      )}

      <ErrorNote message={error} />

      {schedule && schedule.unscheduledTrips.length > 0 && (
        <section className="overflow-hidden rounded-xl border border-amber-300 bg-amber-50 shadow-sm">
          <div className="border-b border-amber-200 px-5 py-3">
            <h2 className="text-sm font-semibold text-amber-900">
              {schedule.unscheduledTrips.length === 1
                ? "1 trip with no shift covering it"
                : `${schedule.unscheduledTrips.length} trips with no shift covering them`}
            </h2>
            <p className="mt-0.5 text-xs text-amber-800">
              Assigned to {schedule.driver.name}, but outside every rostered shift in this range.
            </p>
          </div>
          <div className="px-5 py-2">
            {schedule.unscheduledTrips.map((t) => (
              <TripLine key={t.id} trip={t} />
            ))}
          </div>
        </section>
      )}

      <Card
        title={
          schedule
            ? `Shifts · ${onDate(startOfDayIso(from))} to ${onDate(startOfDayIso(to))}`
            : "Shifts"
        }
      >
        {loading && <Empty>Loading…</Empty>}
        {!loading && schedule && schedule.shifts.length === 0 && (
          <Empty>No shifts rostered in this range.</Empty>
        )}
        {!loading &&
          schedule?.shifts.map((s) => (
            <ShiftBlock
              key={s.id}
              shift={s}
              isAdmin={isAdmin}
              onEdit={() => setEditor({ shift: s, driverId })}
            />
          ))}
      </Card>

      {editor && (
        <ShiftEditor
          state={editor}
          vehicles={vehicles}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

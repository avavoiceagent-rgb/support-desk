// The dispatch board: every driver on one date, time running left to right.
//
// A list by driver answered "is Marco free on Thursday?" but not the question
// a dispatcher actually has at nine in the morning — "somebody wants a car at
// three, who can take it?" That one is answered by looking down a column, so
// the day is a column and each driver is a row.
//
// Green is the window a driver said they would work. Red is the part of it
// already sold. Amber is a trip with no green underneath it at all, which is
// the one thing on this screen that should never be quietly absorbed into a
// neighbouring bar.

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  opsApi,
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
  ErrorNote,
  Field,
  Modal,
  apiMessage,
  atTime,
  inputClass,
  shortAddress,
  span,
  when,
} from "./shared";
import {
  OPERATING_ZONE_LABEL,
  dayMonth,
  dayStartMs,
  longDate,
  shiftDate,
  todayInZone,
} from "../../lib/time";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

interface Band {
  leftPct: number;
  widthPct: number;
  clippedStart: boolean;
  clippedEnd: boolean;
}

/**
 * An interval as a position on the board, or null if it misses the day.
 *
 * Shifts here run up to eleven hours and can start at ten at night, so a good
 * few of them genuinely run off the end of the day. They are clipped and
 * marked rather than dropped: a bar that stops dead at midnight with no sign
 * it continues reads as a driver going home when they are still working.
 */
function band(startMs: number, endMs: number, dayStart: number): Band | null {
  const dayEnd = dayStart + DAY_MS;
  if (endMs <= dayStart || startMs >= dayEnd) return null;
  const from = Math.max(startMs, dayStart);
  const to = Math.min(endMs, dayEnd);
  return {
    leftPct: ((from - dayStart) / DAY_MS) * 100,
    widthPct: Math.max(((to - from) / DAY_MS) * 100, 0.6),
    clippedStart: startMs < dayStart,
    clippedEnd: endMs > dayEnd,
  };
}

function tripEndMs(trip: Trip): number {
  return new Date(trip.pickupAt).getTime() + trip.bookedHours * HOUR_MS;
}

const HOURS = Array.from({ length: 24 }, (_, h) => h);

function hourLabel(h: number): string {
  if (h === 0) return "12a";
  if (h === 12) return "12p";
  return h < 12 ? `${h}a` : `${h - 12}p`;
}

function Gridlines() {
  return (
    <div className="pointer-events-none absolute inset-0 flex">
      {HOURS.map((h) => (
        <div
          key={h}
          className={`flex-1 border-l ${h % 6 === 0 ? "border-gray-300" : "border-gray-100"}`}
        />
      ))}
    </div>
  );
}

function ClipMark({ side }: { side: "start" | "end" }) {
  return (
    <span
      className={`absolute top-0 bottom-0 w-1 bg-white/50 ${side === "start" ? "left-0" : "right-0"}`}
    />
  );
}

function DriverRow({
  driver,
  schedule,
  dayStart,
  isAdmin,
  onEditShift,
  onAddShift,
  onPickTrip,
}: {
  driver: Driver;
  schedule: DriverSchedule | null;
  dayStart: number;
  isAdmin: boolean;
  onEditShift: (shift: Shift) => void;
  onAddShift: () => void;
  onPickTrip: (trip: Trip) => void;
}) {
  const shifts = schedule?.shifts ?? [];
  const uncovered = schedule?.unscheduledTrips ?? [];

  // A night shift means two rows here — the tail of last night's and the whole
  // of tonight's — and printed as bare clock times the two are word for word
  // identical, which reads as a duplicate rather than as two separate shifts.
  // The one that began before this date is dated.
  const windows = shifts
    .filter((s) => band(new Date(s.startsAt).getTime(), new Date(s.endsAt).getTime(), dayStart))
    .map((s) => {
      const carriedOver = new Date(s.startsAt).getTime() < dayStart;
      const from = carriedOver
        ? `${dayMonth(s.startsAt)} · `
        : "";
      return {
        id: s.id,
        text: `${from}${atTime(s.startsAt)} – ${atTime(s.endsAt)}${s.unavailable ? " (off)" : ""}`,
      };
    });

  return (
    <div className="flex items-stretch border-t border-gray-100">
      <div className="w-40 shrink-0 px-3 py-2">
        <p className="truncate text-sm font-medium text-gray-900" title={driver.name}>
          {driver.name}
        </p>
        <p className="truncate text-[11px] text-gray-500">
          {driver.defaultVehicle?.label ?? "No car"}
        </p>
      </div>

      <div className="flex w-32 shrink-0 flex-col justify-center px-2 py-2">
        {windows.length === 0 ? (
          <span className="text-[11px] text-gray-400">Not working</span>
        ) : (
          windows.map((w) => (
            <span key={w.id} className="text-[11px] tabular-nums text-gray-600">
              {w.text}
            </span>
          ))
        )}
        {isAdmin && (
          <button
            onClick={onAddShift}
            className="mt-0.5 text-left text-[11px] font-medium text-indigo-600 hover:text-indigo-800"
          >
            + shift
          </button>
        )}
      </div>

      <div className="relative min-w-0 flex-1 py-2 pr-3">
        <div className="relative h-8 rounded bg-gray-50">
          <Gridlines />

          {shifts.map((s) => {
            const b = band(new Date(s.startsAt).getTime(), new Date(s.endsAt).getTime(), dayStart);
            if (!b) return null;
            const label = `${span(s.startsAt, s.endsAt)}${s.vehicle ? ` · ${s.vehicle.label}` : ""}${
              s.unavailable ? ` · unavailable${s.reason ? `: ${s.reason}` : ""}` : ""
            }`;
            return (
              <button
                key={s.id}
                title={label}
                onClick={() => isAdmin && onEditShift(s)}
                style={{ left: `${b.leftPct}%`, width: `${b.widthPct}%` }}
                className={`absolute top-1 bottom-1 rounded ${
                  s.unavailable
                    ? "bg-slate-300 ring-1 ring-inset ring-slate-400"
                    : "bg-emerald-400/70 ring-1 ring-inset ring-emerald-500"
                } ${isAdmin ? "cursor-pointer hover:brightness-95" : "cursor-default"}`}
              >
                {b.clippedStart && <ClipMark side="start" />}
                {b.clippedEnd && <ClipMark side="end" />}
              </button>
            );
          })}

          {shifts.flatMap((s) =>
            s.trips.map((t) => {
              const b = band(new Date(t.pickupAt).getTime(), tripEndMs(t), dayStart);
              if (!b) return null;
              return (
                <button
                  key={t.id}
                  title={`${t.reference} · ${when(t.pickupAt)} · ${t.bookedHours}h · ${t.passengerName} · ${shortAddress(t.pickupAddress)} → ${shortAddress(t.dropoffAddress)}`}
                  onClick={() => onPickTrip(t)}
                  style={{ left: `${b.leftPct}%`, width: `${b.widthPct}%` }}
                  className="absolute top-2 bottom-2 rounded bg-red-500 ring-1 ring-inset ring-red-700 hover:brightness-110"
                >
                  {b.clippedStart && <ClipMark side="start" />}
                  {b.clippedEnd && <ClipMark side="end" />}
                </button>
              );
            })
          )}

          {uncovered.map((t) => {
            const b = band(new Date(t.pickupAt).getTime(), tripEndMs(t), dayStart);
            if (!b) return null;
            return (
              <button
                key={t.id}
                title={`No shift covers this — ${t.reference} · ${when(t.pickupAt)} · ${t.bookedHours}h · ${t.passengerName}`}
                onClick={() => onPickTrip(t)}
                style={{ left: `${b.leftPct}%`, width: `${b.widthPct}%` }}
                className="absolute top-2 bottom-2 rounded bg-amber-400 ring-2 ring-inset ring-amber-600 hover:brightness-110"
              >
                {b.clippedStart && <ClipMark side="start" />}
                {b.clippedEnd && <ClipMark side="end" />}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function ShiftEditor({
  shift,
  driverId,
  date,
  vehicles,
  onClose,
  onSaved,
}: {
  shift: Shift | null;
  driverId: string;
  date: string;
  vehicles: Vehicle[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [startsAt, setStartsAt] = useState(
    shift ? toDateTimeInput(shift.startsAt) : `${date}T08:00`
  );
  const [endsAt, setEndsAt] = useState(() =>
    shift
      ? toDateTimeInput(shift.endsAt)
      : toDateTimeInput(new Date(new Date(fromDateTimeInput(`${date}T08:00`)).getTime() + 11 * HOUR_MS))
  );
  const [vehicleId, setVehicleId] = useState(shift?.vehicle?.id ?? "");
  const [unavailable, setUnavailable] = useState(shift?.unavailable ?? false);
  const [reason, setReason] = useState(shift?.reason ?? "");
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
      if (shift) await opsApi.updateShift(shift.id, body);
      else await opsApi.createShift({ driverId, ...body });
      onSaved();
    } catch (err) {
      setError(apiMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!shift) return;
    setError(null);
    setSaving(true);
    try {
      await opsApi.deleteShift(shift.id);
      onSaved();
    } catch (err) {
      setError(apiMessage(err));
    } finally {
      setSaving(false);
    }
  }

  const booked = shift?.trips.length ?? 0;

  return (
    <Modal title={shift ? "Edit shift" : "Add shift"} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Starts ({OPERATING_ZONE_LABEL})">
            <input
              type="datetime-local"
              value={startsAt}
              onChange={(e) => setStartsAt(e.target.value)}
              className={inputClass}
              required
            />
          </Field>
          <Field label="Ends" hint="New York time. A shift can run up to 24 hours.">
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
            does not cancel {booked === 1 ? "it" : "them"} — {booked === 1 ? "it turns" : "they turn"}{" "}
            amber instead.
          </p>
        )}

        <ErrorNote message={error} />

        <div className="flex items-center justify-between gap-2 pt-1">
          {shift ? (
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
              {saving ? "Saving…" : shift ? "Save changes" : "Add shift"}
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

function TripCard({ trip, onClose }: { trip: Trip; onClose: () => void }) {
  return (
    <Modal title={`${trip.reference} · ${trip.passengerName}`} onClose={onClose}>
      <dl className="space-y-2 text-sm">
        <div className="flex gap-2">
          <dt className="w-24 shrink-0 text-gray-500">Pickup</dt>
          <dd className="text-gray-900">
            {when(trip.pickupAt)} · {trip.bookedHours}h
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-24 shrink-0 text-gray-500">Route</dt>
          <dd className="text-gray-900">
            {trip.pickupAddress} → {trip.dropoffAddress}
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-24 shrink-0 text-gray-500">Car</dt>
          <dd className="text-gray-900">
            {trip.vehicleClass}
            {trip.vehicle ? ` · ${trip.vehicle.label}` : ""}
            {trip.passengerCount != null ? ` · ${trip.passengerCount} pax` : ""}
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-24 shrink-0 text-gray-500">Status</dt>
          <dd className="text-gray-900">{trip.status}</dd>
        </div>
        {trip.notes && (
          <div className="flex gap-2">
            <dt className="w-24 shrink-0 text-gray-500">Notes</dt>
            <dd className="text-gray-900">{trip.notes}</dd>
          </div>
        )}
      </dl>
      <p className="mt-4 text-xs text-gray-500">
        Change the driver, time or status on the Reservations tab.
      </p>
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
  const [date, setDate] = useState(todayInZone);
  const [showInactive, setShowInactive] = useState(false);
  const [schedules, setSchedules] = useState<Record<string, DriverSchedule>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ shift: Shift | null; driverId: string } | null>(null);
  const [trip, setTrip] = useState<Trip | null>(null);

  const visible = useMemo(
    () => drivers.filter((d) => showInactive || d.active),
    [drivers, showInactive]
  );

  const load = useCallback(async () => {
    if (drivers.length === 0) return;
    setLoading(true);
    setError(null);
    const window = { from: startOfDayIso(date), to: endOfDayIso(date) };
    // One request per driver. The board needs every driver's day at once and
    // there is no endpoint that returns the whole fleet, so this fans out
    // rather than inventing one. Sixteen parallel reads is fine for an
    // internal screen; if the fleet ever gets big it wants a single endpoint.
    const results = await Promise.allSettled(
      drivers.map((d) => opsApi.schedule(d.id, window).then((s) => [d.id, s] as const))
    );
    const next: Record<string, DriverSchedule> = {};
    let failure: string | null = null;
    for (const r of results) {
      if (r.status === "fulfilled") next[r.value[0]] = r.value[1];
      else failure = apiMessage(r.reason);
    }
    setSchedules(next);
    // A driver whose row failed to load is shown as a gap, so say so rather
    // than letting an empty row read as "nothing booked".
    setError(failure && `Some drivers could not be loaded: ${failure}`);
    setLoading(false);
  }, [drivers, date]);

  useEffect(() => {
    void load();
  }, [load]);

  const dayStart = dayStartMs(date);

  const uncoveredCount = visible.reduce(
    (n, d) => n + (schedules[d.id]?.unscheduledTrips.length ?? 0),
    0
  );
  const bookedCount = visible.reduce(
    (n, d) => n + (schedules[d.id]?.shifts.reduce((m, s) => m + s.trips.length, 0) ?? 0),
    0
  );
  const workingCount = visible.filter((d) =>
    (schedules[d.id]?.shifts ?? []).some((s) => !s.unavailable)
  ).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-gray-200 bg-white px-5 py-4 shadow-sm">
        <div>
          <Field label="Date">
            <div className="flex items-center gap-1">
              <button
                onClick={() => setDate(shiftDate(date, -1))}
                className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm text-gray-600 hover:border-gray-400"
                aria-label="Previous day"
              >
                ‹
              </button>
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className={inputClass}
              />
              <button
                onClick={() => setDate(shiftDate(date, 1))}
                className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm text-gray-600 hover:border-gray-400"
                aria-label="Next day"
              >
                ›
              </button>
            </div>
          </Field>
        </div>
        <Button onClick={() => setDate(todayInZone())}>Today</Button>
        <label className="flex items-center gap-2 pb-1.5 text-sm text-gray-600">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
            className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
          />
          Show deactivated drivers
        </label>

        <div className="ml-auto flex flex-wrap items-center gap-4 pb-1 text-xs text-gray-600">
          <span className="flex items-center gap-1.5">
            <span className="h-3 w-4 rounded-sm bg-emerald-400/70 ring-1 ring-inset ring-emerald-500" />
            Available
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-3 w-4 rounded-sm bg-red-500" />
            Booked
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-3 w-4 rounded-sm bg-amber-400 ring-2 ring-inset ring-amber-600" />
            No shift covering it
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-3 w-4 rounded-sm bg-slate-300" />
            Time off
          </span>
        </div>
      </div>

      <ErrorNote message={error} />

      <section className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-5 py-3">
          <h2 className="text-sm font-semibold text-gray-900">
            {longDate(new Date(dayStart).toISOString())}
            <span className="ml-2 font-normal text-gray-400">
              all times {OPERATING_ZONE_LABEL}
            </span>
          </h2>
          <p className="text-xs text-gray-500">
            {workingCount} of {visible.length} drivers working ·{" "}
            {bookedCount === 1 ? "1 trip" : `${bookedCount} trips`} booked
            {uncoveredCount > 0 && (
              <span className="font-medium text-amber-700">
                {" "}
                · {uncoveredCount} with no shift covering {uncoveredCount === 1 ? "it" : "them"}
              </span>
            )}
          </p>
        </div>

        <div className="overflow-x-auto">
          <div className="min-w-[56rem]">
            <div className="flex items-end border-b border-gray-200 bg-gray-50">
              <div className="w-40 shrink-0 px-3 py-2 text-[11px] font-medium text-gray-500">
                Driver
              </div>
              <div className="w-32 shrink-0 px-2 py-2 text-[11px] font-medium text-gray-500">
                Availability
              </div>
              <div className="min-w-0 flex-1 pr-3">
                <div className="flex">
                  {HOURS.map((h) => (
                    <div
                      key={h}
                      className={`flex-1 border-l py-1 text-center text-[10px] tabular-nums ${
                        h % 6 === 0 ? "border-gray-300 text-gray-700" : "border-gray-100 text-gray-500"
                      }`}
                    >
                      {h % 3 === 0 ? hourLabel(h) : ""}
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {loading && visible.length > 0 && (
              <p className="px-5 py-8 text-center text-sm text-gray-500">Loading the board…</p>
            )}

            {!loading &&
              visible.map((d) => (
                <DriverRow
                  key={d.id}
                  driver={d}
                  schedule={schedules[d.id] ?? null}
                  dayStart={dayStart}
                  isAdmin={isAdmin}
                  onEditShift={(s) => setEditor({ shift: s, driverId: d.id })}
                  onAddShift={() => setEditor({ shift: null, driverId: d.id })}
                  onPickTrip={setTrip}
                />
              ))}

            {!loading && visible.length === 0 && (
              <p className="px-5 py-8 text-center text-sm text-gray-500">No drivers to show.</p>
            )}
          </div>
        </div>
      </section>

      {editor && (
        <ShiftEditor
          shift={editor.shift}
          driverId={editor.driverId}
          date={date}
          vehicles={vehicles}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null);
            void load();
          }}
        />
      )}

      {trip && <TripCard trip={trip} onClose={() => setTrip(null)} />}
    </div>
  );
}

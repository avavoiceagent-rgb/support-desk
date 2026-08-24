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
import { VEHICLE_CLASSES, OPERATING_ZONE_LABEL, dispatchApi, opsApi } from "../api/ops";
import type { ContactKind, TripCandidates } from "../api/ops";
import { when, toDateTimeInput, instantFromInput } from "../lib/time";
import { useAuth } from "../hooks/useAuth";
import { pastBookingWarning } from "../lib/bookings";

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

export function ReservationPanel({
  ticketId,
  onTicketChanged,
}: {
  ticketId: string;
  /**
   * Called after anything here writes something the ticket timeline shows.
   *
   * This panel reloads its own data, which is not the same as the ticket
   * reloading: a change made here wrote a trip event and possibly a message
   * to a driver, and both belong in the timeline the parent is holding. Left
   * out, the desk changed a booking and the page gave no sign it had.
   */
  onTicketChanged?: () => void;
}) {
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
  /**
   * Bumped every time this panel reloads.
   *
   * The "who can take it" section fetched once and never again, because its
   * only dependency was the trip id — which does not change when the trip
   * does. So after moving a pickup it went on showing the answer from before
   * the move: the driver was flagged as told about a change made after the
   * last word to them. Passing this through makes a reload of the panel a
   * reload of that question too.
   */
  const [version, setVersion] = useState(0);
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
      setVersion((n) => n + 1);
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
        pickupAt: instantFromInput(change.pickupAtLocal, changing.pickupAt),
        bookedHours: Number(change.bookedHours),
      });
      setChanged(`${updated.reference} moved to ${when(updated.pickupAt)}.`);
      setChanging(null);
      await load();
      onTicketChanged?.();
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
      onTicketChanged?.();
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
        <WhoCanTakeIt tripId={trip.id} version={version} onSent={onTicketChanged} />
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

              {/* A change made from here moves a booking somebody may already
                  have accepted, so the same warning belongs here — this is
                  the ticket where that change actually gets made. */}
              <WhoCanTakeIt tripId={q.id} version={version} onSent={onTicketChanged} />

              {changing?.id === q.id ? (
                <form onSubmit={saveChange} className="mt-2 space-y-2">
                  {pastBookingWarning(q, q.reference) && (
                    <p className="rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-900">
                      {pastBookingWarning(q, q.reference)}
                    </p>
                  )}
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

/**
 * Who could take this booking, and one press to offer it to them.
 *
 * The query behind this has existed since the rota was built and was called by
 * nothing: a dispatcher looking at a new reservation still had to work out who
 * was free by reading the schedule board. Availability is not a judgement — a
 * shift either covers the window or it does not — so the desk should simply
 * say, and it should say it where the booking was just made rather than two
 * screens away.
 *
 * Sending an offer does not assign anybody. It asks. The assignment happens
 * when they accept, which is the same rule the Messages screen follows.
 */
function WhoCanTakeIt({
  tripId,
  version,
  onSent,
}: {
  tripId: string;
  /** Changes whenever the booking may have moved; see ReservationPanel. */
  version: number;
  onSent?: () => void;
}) {
  const [candidates, setCandidates] = useState<TripCandidates | null>(null);
  const [loading, setLoading] = useState(true);
  const [offeredTo, setOfferedTo] = useState<string[]>([]);
  const [sending, setSending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showMessage, setShowMessage] = useState(false);

  const refresh = useCallback(() => {
    setLoading(true);
    return opsApi
      .candidates(tripId)
      // A failed lookup is not worth an error box next to a form somebody is
      // in the middle of filling in.
      .then(setCandidates)
      .catch(() => setCandidates(null))
      .finally(() => setLoading(false));
  }, [tripId]);

  // `version` changes whenever the panel around this reloads, which is the
  // signal that the booking may have moved. Without it the answer here was
  // fetched once on mount and never revisited.
  useEffect(() => {
    void refresh();
  }, [refresh, version]);

  async function offer(kind: ContactKind, id: string, label: string) {
    setError(null);
    setSending(id);
    try {
      await dispatchApi.sendOffer(kind, id, tripId);
      setOfferedTo((sent) => [...sent, label]);
      await refresh();
      // The offer is now a line in the timeline. Say so to the parent, which
      // is the thing holding it.
      onSent?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not send that offer.");
    } finally {
      setSending(null);
    }
  }

  async function tell(kind: ContactKind, id: string, label: string) {
    setError(null);
    setSending(id);
    try {
      await dispatchApi.sendChangeNotice(kind, id, tripId);
      setOfferedTo((sent) => [...sent, label]);
      // Telling them is exactly what this panel was warning about, so it has
      // to go and ask again rather than sit there still warning.
      await refresh();
      onSent?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not send that message.");
    } finally {
      setSending(null);
    }
  }

  if (loading) return <p className="mt-2 text-xs text-gray-400">Checking who is free…</p>;
  if (!candidates) return null;

  const { drivers, partners, fallbackReason, offerText, assignment } = candidates;

  // Somebody already has this job. The only questions worth asking are
  // whether they know what it says now, and whether they can still do it.
  if (assignment) {
    const held = assignment.name;
    const outOfDate = assignment.toldOfLatest === false;
    const lost = assignment.stillAvailable === false;
    if (!outOfDate && !lost) return null;

    return (
      <div className="mt-2 space-y-2 border-t border-emerald-200 pt-2">
        {lost ? (
          <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-900">
            <span className="font-semibold">{held} no longer fits this booking.</span> Since it
            changed, their shift does not cover it or they are out on another job. Tell them, and
            find somebody else.
          </p>
        ) : (
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            <span className="font-semibold">{held} has not been told.</span> This booking changed
            after the last message to them, so what they agreed to is not what it now says.
          </p>
        )}

        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => setShowMessage((open) => !open)}
            className="text-[11px] font-medium text-indigo-600 hover:text-indigo-800"
          >
            {showMessage ? "Hide message" : "See message"}
          </button>
          <OfferButton
            label={offeredTo.includes(held) ? "Sent" : `Send the change to ${held}`}
            disabled={offeredTo.includes(held) || sending !== null}
            busy={sending === assignment.contactId}
            onClick={() => tell(assignment.kind, assignment.contactId, held)}
          />
        </div>

        {showMessage && (
          <pre className="whitespace-pre-wrap rounded border border-gray-200 bg-white px-2 py-1.5 text-[11px] leading-relaxed text-gray-700">
            {offerText}
          </pre>
        )}

        {lost && (drivers.length > 0 || partners.length > 0) && (
          <div>
            <p className="text-xs font-medium text-gray-700">Who could take it instead</p>
            <ReplacementList
              drivers={drivers}
              partners={partners}
              offeredTo={offeredTo}
              sending={sending}
              onOffer={offer}
            />
          </div>
        )}
        {lost && drivers.length === 0 && partners.length === 0 && (
          <p className="text-xs text-gray-600">
            Nobody else covers this window either. This one needs a shift moving or a call.
          </p>
        )}
        {error && <p className="text-[11px] text-red-700">{error}</p>}
      </div>
    );
  }

  if (drivers.length === 0 && partners.length === 0) {
    return (
      <p className="mt-2 border-t border-emerald-200 pt-2 text-xs text-gray-600">
        Nobody on the roster covers this window, and no partner matches it either. This one needs
        a shift moving or a call.
      </p>
    );
  }

  return (
    <div className="mt-2 border-t border-emerald-200 pt-2">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-xs font-medium text-gray-700">
          {drivers.length > 0
            ? `${drivers.length} ${drivers.length === 1 ? "driver is" : "drivers are"} free`
            : fallbackReason === "OUT_OF_AREA"
              ? "Leaves the service area — partners who cover it"
              : "No car of ours is free — partners to call"}
        </p>
        <button
          type="button"
          onClick={() => setShowMessage((open) => !open)}
          className="text-[11px] font-medium text-indigo-600 hover:text-indigo-800"
        >
          {showMessage ? "Hide message" : "See message"}
        </button>
      </div>

      {showMessage && (
        // The real text, not a description of it. Anybody about to send
        // something to a driver should be able to read it first.
        <pre className="mt-1.5 whitespace-pre-wrap rounded border border-gray-200 bg-white px-2 py-1.5 text-[11px] leading-relaxed text-gray-700">
          {offerText}
        </pre>
      )}

      <ReplacementList
        drivers={drivers}
        partners={partners}
        offeredTo={offeredTo}
        sending={sending}
        onOffer={offer}
      />

      {offeredTo.length > 0 && (
        <p className="mt-1.5 text-[11px] text-gray-600">
          Offered to {offeredTo.join(", ")}. Nobody is assigned until one of them accepts — answers
          come back in Operations → Messages.
        </p>
      )}
      {error && <p className="mt-1.5 text-[11px] text-red-700">{error}</p>}
    </div>
  );
}

/** The list of people who could take a job, and the button that asks them. */
function ReplacementList({
  drivers,
  partners,
  offeredTo,
  sending,
  onOffer,
}: {
  drivers: TripCandidates["drivers"];
  partners: TripCandidates["partners"];
  offeredTo: string[];
  sending: string | null;
  onOffer: (kind: ContactKind, id: string, label: string) => void;
}) {
  return (
    <ul className="mt-1.5 space-y-1">
      {drivers.map((d) => (
        <li key={d.driverId} className="flex items-center justify-between gap-2 text-xs">
          <span className="text-gray-800">
            {d.name}
            <span className="text-gray-500">
              {d.vehicleLabel ? ` · ${d.vehicleLabel}` : ""}
              {d.tripsThatDay > 0
                ? ` · ${d.tripsThatDay} ${d.tripsThatDay === 1 ? "job" : "jobs"} today`
                : " · free all day"}
            </span>
          </span>
          <OfferButton
            label={offeredTo.includes(d.name) ? "Offered" : "Send offer"}
            disabled={offeredTo.includes(d.name) || sending !== null}
            busy={sending === d.driverId}
            onClick={() => onOffer("DRIVER", d.driverId, d.name)}
          />
        </li>
      ))}

      {partners.map((p) => (
        <li key={p.affiliateId} className="flex items-center justify-between gap-2 text-xs">
          <span className="text-gray-800">
            {p.company}
            <span className="text-gray-500">
              {" · "}
              {p.quote.priced
                ? `$${(p.quote.quote.totalCents / 100).toLocaleString("en-US")} for ${p.quote.quote.billableHours}h`
                : "price to agree"}
            </span>
          </span>
          <OfferButton
            label={offeredTo.includes(p.company) ? "Offered" : "Send offer"}
            disabled={offeredTo.includes(p.company) || sending !== null}
            busy={sending === p.affiliateId}
            onClick={() => onOffer("AFFILIATE", p.affiliateId, p.company)}
          />
        </li>
      ))}
    </ul>
  );
}

function OfferButton({
  label,
  disabled,
  busy,
  onClick,
}: {
  label: string;
  disabled: boolean;
  busy: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="shrink-0 rounded border border-indigo-200 bg-white px-2 py-0.5 text-[11px] font-medium text-indigo-700 transition-colors hover:border-indigo-400 disabled:cursor-not-allowed disabled:border-gray-200 disabled:text-gray-400"
    >
      {busy ? "Sending…" : label}
    </button>
  );
}

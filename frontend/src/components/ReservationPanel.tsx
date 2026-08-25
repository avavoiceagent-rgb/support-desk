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
import { draftToPlainText } from "./DraftCard";
import { Link } from "react-router-dom";
import { api, ApiError } from "../api/client";
import type { Trip, VehicleClass } from "../api/ops";
import { VEHICLE_CLASSES, OPERATING_ZONE_LABEL, dispatchApi, opsApi } from "../api/ops";
import type { ContactKind, PartnerQuote, TripCandidates } from "../api/ops";
import { money, parseMoney } from "../lib/money";
import { when, toDateTimeInput, instantFromInput, fromDateTimeInput } from "../lib/time";
import { useAuth } from "../hooks/useAuth";
import { pastBookingWarning } from "../lib/bookings";
import { lateChangeWarning, type FlightBooking } from "../lib/flights";

/** A booking this email names by reference. */
interface QuotedTrip {
  id: string;
  reference: string;
  /** The flight the pickup was worked back from, so a change can be checked. */
  flightAt: string | null;
  flightKind: string | null;
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
  /** The flight the pickup was worked back from. Absent on older drafts. */
  flightTimeLocal?: string | null;
  flightKind?: "DOMESTIC" | "INTERNATIONAL" | null;
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
  onDraftReply,
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
  /**
   * Hand a written email to the reply box for somebody to read and send.
   *
   * Creating a reservation and changing one both produce something the
   * customer needs to be told, and the desk knows every word of it — the
   * reference, the time, the two addresses. So it writes it. What it does not
   * do is send it: it lands in the composer, a person reads it, a person
   * presses Send. That is the same rule Adam's first reply follows, and it is
   * the reason this is a callback rather than a call to the mail provider.
   */
  onDraftReply?: (bodyHtml: string) => void;
}) {
  const { user } = useAuth();
  const isAdmin = user?.role === "ADMIN";

  const [trip, setTrip] = useState<Trip | null>(null);
  const [suggested, setSuggested] = useState<DraftFacts | null>(null);
  const [quoted, setQuoted] = useState<QuotedTrip[]>([]);
  const [unresolved, setUnresolved] = useState<string[]>([]);
  const [confirmed, setConfirmed] = useState<string | null>(null);
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
      await offerConfirmation(updated.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not change the booking.");
    } finally {
      setSaving(false);
    }
  }

  /**
   * Put the confirmation in the reply box.
   *
   * Deliberately after the booking is already saved and the panel has
   * reloaded, and deliberately swallowing its own failure: the reservation is
   * the thing that mattered and it is done. A confirmation that could not be
   * fetched is a person writing an email by hand, not a booking half made.
   */
  /**
   * Put the confirmation in the reply box.
   *
   * `quiet` is the difference between this happening on its own and somebody
   * asking for it. After a Create it is a courtesy, and a failure should not
   * push a booking that did save off the screen. Pressing a button and getting
   * nothing at all is a different thing entirely — that is the complaint that
   * started this — so a deliberate press says what went wrong.
   */
  async function offerConfirmation(
    tripId: string,
    form?: "NEW" | "CHANGE",
    quiet = form === undefined
  ) {
    if (!onDraftReply) return;
    setError(null);
    setConfirmed(null);
    try {
      const confirmation = await opsApi.confirmation(tripId, ticketId, form);
      // A change nobody outside the office would notice — a driver assigned,
      // a note edited — has nothing to tell the customer, and an email saying
      // "we have updated your booking" followed by nothing that moved reads
      // as though we had lost track of it.
      if (!confirmation.tellsThemAnything) {
        if (!quiet) setError("Nothing has changed that the customer was ever told about.");
        return;
      }
      // The composer is a plain-text box, so it gets the same treatment
      // Adam's own draft gets on its way in.
      onDraftReply(draftToPlainText(confirmation.bodyHtml));
      setConfirmed(
        confirmation.kind === "CHANGE"
          ? "The change confirmation is in the reply box below — read it and press Send."
          : "The confirmation is in the reply box below — read it and press Send."
      );
    } catch (err) {
      if (quiet) return;
      setError(
        err instanceof ApiError ? err.message : "Could not write that confirmation email."
      );
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

  /**
   * The draft's own answer, in the shape the flight check reads.
   *
   * There is no booking yet, so the drive time is recovered from the time
   * Adam calculated rather than from a saved pickup: that time already has
   * the drive and its cushion in it, which is exactly what the check needs.
   * Null whenever the draft had no flight to work from, in which case there
   * is nothing to be late for.
   */
  const suggestedFlight: FlightBooking | null =
    suggested?.flightTimeLocal && suggested?.pickupAtLocal
      ? {
          flightAt: fromDateTimeInput(suggested.flightTimeLocal),
          flightKind: suggested.flightKind ?? null,
          pickupAt: fromDateTimeInput(suggested.pickupAtLocal),
        }
      : null;

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
        // Carried straight from the facts: the flight is what the pickup was
        // worked back from, and the booking should hold it rather than only
        // the answer it produced.
        flightAtLocal: suggested?.flightTimeLocal ?? null,
        flightKind: suggested?.flightKind ?? null,
      });
      setTrip(made);
      setOpen(false);
      onTicketChanged?.();
      await offerConfirmation(made.id);
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
        {/* What the pickup was worked back from, and how to reach them —
            both arrive in a reply rather than the first email, so this is
            where you can see whether they landed. */}
        {/* Both sides of a farmed-out job. The cost is ours to know and the
            price is what the customer was told; showing only one of them is
            how a desk loses track of what it makes. */}
        {typeof trip.customerPriceCents === "number" && (
          <p className="text-xs text-gray-600">
            {money(trip.customerPriceCents)} to the customer
            {typeof trip.partnerQuoteCents === "number"
              ? ` · ${money(trip.partnerQuoteCents)} to the partner`
              : ""}
          </p>
        )}
        {trip.flightAt && (
          <p className="text-xs text-gray-600">
            Flight {when(trip.flightAt)}
            {trip.flightKind ? ` · ${trip.flightKind.toLowerCase()}` : ""}
            {trip.flightNumber ? ` · ${trip.flightNumber}` : ""}
          </p>
        )}
        {trip.passengerPhone && <p className="text-xs text-gray-600">{trip.passengerPhone}</p>}
        <p className="mt-0.5 text-xs text-gray-500">
          {trip.driver?.name ?? trip.affiliate?.company ?? "Nobody assigned yet"}
        </p>
        <div className="mt-1.5 flex flex-wrap items-center gap-3">
          <Link
            to="/operations"
            className="text-xs font-medium text-indigo-600 hover:text-indigo-800"
          >
            Open in Operations →
          </Link>
          {/* Available whenever, not only in the two seconds after Create.
              A farmed-out job has no price when the booking is made — it gets
              one when a partner quotes and we take it, which can be an hour
              later and through a different screen. Without this there was no
              way back to the confirmation at the moment it finally had
              something worth confirming. */}
          {onDraftReply && (
            <button
              type="button"
              onClick={() => void offerConfirmation(trip.id, "NEW")}
              className="text-xs font-medium text-indigo-600 hover:text-indigo-800"
            >
              Confirmation email
              {typeof trip.customerPriceCents === "number" ? " (with the price)" : ""}
            </button>
          )}
        </div>
        {/* This branch had nowhere to say anything. A press that failed set an
            error nobody rendered, and a press that worked put text in a box
            off the bottom of the screen — both of which read as the link
            doing nothing at all. */}
        {confirmed && <p className="mt-1.5 text-[11px] text-emerald-800">{confirmed}</p>}
        {error && <p className="mt-1.5 text-[11px] text-red-700">{error}</p>}
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
                  {/* Under the box, not above it. The consequence of a time
                      belongs where the eye already is — a reader typing into
                      the field has no reason to look back up the form. */}
                  <MissedFlightWarning warning={lateChangeWarning(q, change.pickupAtLocal)} />
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

      {/* The gap between the two places the rule was already enforced. Adam
          works the time out, and a change to a saved booking gets checked
          against the flight — but this box sits between them, pre-filled and
          editable, and a time typed over it went to a car unexamined.

          Outside the label rather than in it: a screen reader would otherwise
          read the whole warning out as the name of the field. */}
      <MissedFlightWarning
        warning={suggestedFlight && lateChangeWarning(suggestedFlight, form.pickupAtLocal)}
      />

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

  /** Offering a job to one of our own drivers. Partners go through quoting. */
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

  const { drivers, partners, fallbackReason, coverageNote, offerText, assignment } = candidates;

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
            {drivers.length > 0 ? (
              <ReplacementList
                drivers={drivers}
                offeredTo={offeredTo}
                sending={sending}
                onOffer={offer}
              />
            ) : (
              // Replacing a lost job with a partner is the same thing as
              // farming one out in the first place, and takes the same route:
              // ask what they charge. This used to render a driver list with
              // no drivers in it, which said nothing at all.
              <QuoteBoard
                tripId={tripId}
                partners={partners}
                version={version}
                onChanged={() => {
                  void refresh();
                  onSent?.();
                }}
              />
            )}
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

      {/* Why there is one tick box, or none. Without it the reader has to
          guess whether the roster is short or the screen is broken. */}
      {coverageNote && <p className="mt-1.5 text-[11px] text-amber-800">{coverageNote}</p>}

      {/* Every job that leaves our own cars goes to a partner the same way,
          whether it left the service area or simply found nobody free: we ask
          what they charge, we decide whether it suits, and only then do we
          agree it. The desk does not open with a price.

          It briefly did for overflow jobs, on the reasoning that a rate card
          is already an agreed number. A card says what a partner charged when
          it was last negotiated; a rate request is how you find out what they
          charge for this job today. The card figure survives beside each name
          as the budget to read their answer against.

          The gate below is `fallbackReason` rather than one particular reason,
          and getting that wrong is what put an empty list on this panel: a
          partner list is only ever populated when no car of ours can take the
          job, so any fallback at all belongs here. */}
      {fallbackReason ? (
        <QuoteBoard
          tripId={tripId}
          partners={partners}
          version={version}
          onChanged={() => {
            void refresh();
            onSent?.();
          }}
        />
      ) : (
        <ReplacementList
          drivers={drivers}
          offeredTo={offeredTo}
          sending={sending}
          onOffer={offer}
        />
      )}

      {offeredTo.length > 0 && !fallbackReason && (
        <p className="mt-1.5 text-[11px] text-gray-600">
          Offered to {offeredTo.join(", ")}. Nobody is assigned until one of them accepts — answers
          come back in Operations → Messages.
        </p>
      )}
      {error && <p className="mt-1.5 text-[11px] text-red-700">{error}</p>}
    </div>
  );
}

/**
 * The drivers who could take a job, and the button that offers it.
 *
 * Drivers only. A partner never appears here any more: partners are only ever
 * suggested when no car of ours can take the job, and that always carries a
 * fallback reason, which routes to the quote board instead. We do not open
 * with a price to a partner — we ask what theirs is.
 */
function ReplacementList({
  drivers,
  offeredTo,
  sending,
  onOffer,
}: {
  drivers: TripCandidates["drivers"];
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

/**
 * Farming a job out, in the order it actually happens.
 *
 * A trip that leaves NY/NJ is priced by whoever covers it, and until one of
 * them says a number we do not know what it costs. That is why the customer's
 * first reply carries no price at all. So this asks before it offers: tick two
 * or three partners, send them the reservation, and their prices come back
 * side by side with what each would mean for the customer.
 *
 * Accepting a price does not assign anybody. It offers them the job at the
 * figure they gave, and they still have to accept — a price quoted on Tuesday
 * is not a promise the car is free on Thursday.
 *
 * Until partners have links of their own, somebody at the desk types their
 * answer in. The desk record says who did.
 */
function QuoteBoard({
  tripId,
  partners,
  version,
  onChanged,
}: {
  tripId: string;
  partners: TripCandidates["partners"];
  version: number;
  onChanged: () => void;
}) {
  const [quotes, setQuotes] = useState<PartnerQuote[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(
    () =>
      opsApi
        .quotes(tripId)
        .then(setQuotes)
        .catch(() => setQuotes([])),
    [tripId]
  );
  useEffect(() => {
    void load();
  }, [load, version]);

  const asked = new Set(quotes.map((q) => q.affiliateId));
  const notYetAsked = partners.filter((p) => !asked.has(p.affiliateId));
  const awarded = quotes.find((q) => q.awarded) ?? null;

  async function ask() {
    setError(null);
    setNote(null);
    setBusy("ask");
    try {
      const out = await opsApi.requestQuotes(tripId, [...picked]);
      setPicked(new Set());
      await load();
      // A partner deactivated since this panel was drawn does not stop the
      // request reaching the others — but it must not fail silently either.
      if (out.refused.length) {
        setError(out.refused.map((r) => r.reason).join(" "));
      } else {
        setNote(`Asked ${out.sent.length} ${out.sent.length === 1 ? "partner" : "partners"}.`);
      }
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not send those requests.");
    } finally {
      setBusy(null);
    }
  }

  async function saveQuote(q: PartnerQuote) {
    const cents = parseMoney(typed[q.requestId] ?? "");
    if (cents === null) {
      // This figure becomes what a customer is charged. Refusing it is the
      // only safe answer — a guess here reaches a real person as a price.
      setError(`"${typed[q.requestId] ?? ""}" is not a price. Type it like 210 or 210.50.`);
      return;
    }
    setError(null);
    setBusy(q.requestId);
    try {
      await opsApi.recordQuote(q.requestId, cents);
      setTyped((t) => ({ ...t, [q.requestId]: "" }));
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not record that quote.");
    } finally {
      setBusy(null);
    }
  }

  async function accept(q: PartnerQuote) {
    if (!q.quoteId) return;
    setError(null);
    setBusy(q.quoteId);
    try {
      await opsApi.awardQuote(q.quoteId);
      await load();
      setNote(`${q.company} has been offered the job at ${money(q.amountCents ?? 0)}.`);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not accept that quote.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-1.5 space-y-2">
      {quotes.length > 0 && (
        <ul className="space-y-1">
          {quotes.map((q) => (
            <li key={q.requestId} className="rounded border border-gray-200 bg-white px-2 py-1.5">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="truncate font-medium text-gray-800">{q.company}</span>
                {q.amountCents === null ? (
                  <span className="shrink-0 text-[11px] text-gray-500">Asked, no price yet</span>
                ) : (
                  <span className="shrink-0 text-[11px] text-gray-700">
                    {money(q.amountCents)} cost ·{" "}
                    <span className="font-semibold text-gray-900">
                      {money(q.customerCents ?? 0)}
                    </span>{" "}
                    to charge
                  </span>
                )}
              </div>

              {q.amountCents === null ? (
                <div className="mt-1 flex items-center gap-1.5">
                  <input
                    value={typed[q.requestId] ?? ""}
                    onChange={(e) => setTyped((t) => ({ ...t, [q.requestId]: e.target.value }))}
                    placeholder="Their price, e.g. 210"
                    className="w-32 rounded border border-gray-300 px-1.5 py-0.5 text-[11px]"
                  />
                  <OfferButton
                    label="Record it"
                    disabled={busy !== null}
                    busy={busy === q.requestId}
                    onClick={() => void saveQuote(q)}
                  />
                </div>
              ) : q.awarded ? (
                <p className="mt-1 text-[11px] text-emerald-800">
                  Accepted and offered to them. They are not on the job until they confirm — the
                  answer comes back in Operations → Messages.
                </p>
              ) : awarded ? (
                <p className="mt-1 text-[11px] text-gray-500">
                  Not taken — {awarded.company} has it. Let them know.
                </p>
              ) : (
                <div className="mt-1">
                  <OfferButton
                    label="Accept this price"
                    disabled={busy !== null}
                    busy={busy === q.quoteId}
                    onClick={() => void accept(q)}
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {notYetAsked.length > 0 && !awarded && (
        <div className="rounded border border-dashed border-gray-300 px-2 py-1.5">
          <p className="text-[11px] font-medium text-gray-600">
            {quotes.length ? "Ask somebody else too" : "Ask what they charge"}
          </p>
          <ul className="mt-1 space-y-0.5">
            {notYetAsked.map((p) => (
              <li key={p.affiliateId} className="flex items-center gap-1.5 text-xs">
                <input
                  type="checkbox"
                  id={`ask-${p.affiliateId}`}
                  checked={picked.has(p.affiliateId)}
                  onChange={(e) =>
                    setPicked((set) => {
                      const next = new Set(set);
                      if (e.target.checked) next.add(p.affiliateId);
                      else next.delete(p.affiliateId);
                      return next;
                    })
                  }
                />
                <label htmlFor={`ask-${p.affiliateId}`} className="truncate text-gray-800">
                  {p.company}
                  {/* Their card, where we hold one — what they charged when it
                      was last negotiated, and both halves of it, because
                      deciding whether a quote suits means knowing what it
                      would leave you charging. A reference for reading the
                      price they come back with. Never sent to them. */}
                  {p.quote.priced && (
                    <span className="text-gray-500">
                      {` · card ${money(p.quote.quote.totalCents)} → ${money(p.quote.customerCents)}`}
                    </span>
                  )}
                </label>
              </li>
            ))}
          </ul>
          <div className="mt-1.5">
            <OfferButton
              label={`Ask ${picked.size || ""}`.trim()}
              disabled={picked.size === 0 || busy !== null}
              busy={busy === "ask"}
              onClick={() => void ask()}
            />
          </div>
        </div>
      )}

      {note && <p className="text-[11px] text-gray-600">{note}</p>}
      {error && <p className="text-[11px] text-red-700">{error}</p>}
    </div>
  );
}

/**
 * The one warning on this panel that is about somebody missing a plane.
 *
 * Red rather than the amber used for "did you mean this booking" — those ask
 * a question, this one states a consequence. It never disables anything: the
 * clash check in ops/trips.ts settles the principle, and a flight can be
 * missed on purpose by a customer who has rebooked or is already checked in.
 */
function MissedFlightWarning({ warning }: { warning: string | null }) {
  if (!warning) return null;
  return (
    <p className="mt-1 rounded-lg border border-red-300 bg-red-50 px-2.5 py-1.5 text-[11px] text-red-900">
      {warning}
    </p>
  );
}

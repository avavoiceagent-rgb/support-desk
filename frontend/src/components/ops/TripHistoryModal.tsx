// Who changed this reservation, and what they changed.
//
// Read forwards, oldest at the top, because that is how somebody reconstructs
// what happened before answering a customer who is unhappy about it.
//
// Every line is already in words when it arrives — "Driver: Unassigned →
// Marco Rinaldi" — because the server writes it that way at the moment of the
// change. Nothing here looks anything up, so a driver deactivated last month
// still reads as their name rather than a gap.

import { useEffect, useState } from "react";
import { opsApi, type Trip, type TripEvent } from "../../api/ops";
import { Modal, apiMessage, when } from "./shared";
import { ErrorNote } from "./shared";

const KIND_LABEL: Record<TripEvent["kind"], string> = {
  CREATED: "Created",
  UPDATED: "Changed",
  CANCELLED: "Cancelled",
};

const KIND_STYLE: Record<TripEvent["kind"], string> = {
  CREATED: "bg-emerald-100 text-emerald-800",
  UPDATED: "bg-sky-100 text-sky-800",
  CANCELLED: "bg-amber-100 text-amber-800",
};

function Value({ text }: { text: string | null }) {
  if (text === null || text === "") {
    return <span className="italic text-gray-400">empty</span>;
  }
  return <span className="text-gray-800">{text}</span>;
}

export function TripHistoryModal({ trip, onClose }: { trip: Trip; onClose: () => void }) {
  const [events, setEvents] = useState<TripEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    opsApi
      .tripEvents(trip.id)
      .then((e) => live && setEvents(e))
      .catch((err) => live && setError(apiMessage(err)));
    return () => {
      live = false;
    };
  }, [trip.id]);

  return (
    <Modal title={`${trip.reference} · history`} onClose={onClose}>
      <ErrorNote message={error} />

      {events === null && !error && <p className="py-6 text-center text-sm text-gray-500">Loading…</p>}

      {events?.length === 0 && (
        <div className="py-6 text-center">
          <p className="text-sm text-gray-500">Nothing has changed since this reservation was made.</p>
          <p className="mt-1 text-xs text-gray-400">
            Changes made from this screen are recorded from here on.
          </p>
        </div>
      )}

      {events && events.length > 0 && (
        <ol className="space-y-3">
          {events.map((event) => (
            <li key={event.id} className="border-l-2 border-gray-200 pl-3">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${KIND_STYLE[event.kind]}`}
                >
                  {KIND_LABEL[event.kind]}
                </span>
                <span className="text-sm font-medium text-gray-900">{event.actorName}</span>
                <span className="text-xs text-gray-500">{when(event.createdAt)}</span>
                {event.source && <span className="text-xs text-gray-400">· {event.source}</span>}
              </div>

              {event.changes.length > 0 && (
                <dl className="mt-1.5 space-y-1">
                  {event.changes.map((c) => (
                    <div key={c.field} className="flex flex-wrap items-baseline gap-x-2 text-xs">
                      <dt className="text-gray-500">{c.field}</dt>
                      <dd className="flex items-baseline gap-1.5">
                        <Value text={c.from} />
                        <span className="text-gray-400">→</span>
                        <Value text={c.to} />
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
            </li>
          ))}
        </ol>
      )}
    </Modal>
  );
}

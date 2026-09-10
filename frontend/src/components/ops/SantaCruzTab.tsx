// The SantaCruz bookings, beside the desk's own — not instead of them.
//
// A separate tab rather than a change to Reservations, deliberately. Until the
// move is done these are two different sets of bookings from two different
// systems, and a screen that quietly merged them would make it impossible to
// tell which system a job actually came from at the moment that matters most.
//
// Only the fields somebody has mapped are shown. An unmapped column is not a
// blank column here — it is simply not a column, because a grid full of empty
// cells reads as missing data rather than as a mapping nobody has filled in.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  santacruzApi,
  type FieldMapping,
  type SantaCruzBooking,
  type SantaCruzConnection,
} from "../../api/santacruz";
import { Card, Empty, ErrorNote, apiMessage, when } from "./shared";
import { money } from "../../lib/money";

/** Only the columns the mapping actually fills, in a sensible reading order. */
const COLUMNS: { field: keyof SantaCruzBooking; label: string }[] = [
  { field: "reference", label: "Reference" },
  { field: "pickupAt", label: "Pickup" },
  { field: "passengerName", label: "Passenger" },
  { field: "pickupAddress", label: "From" },
  { field: "dropoffAddress", label: "To" },
  { field: "vehicleClass", label: "Car" },
  { field: "passengerCount", label: "Passengers" },
  { field: "luggageCount", label: "Bags" },
  { field: "driverName", label: "Driver" },
  { field: "priceCents", label: "Price" },
  { field: "status", label: "Status" },
];

function cell(booking: SantaCruzBooking, field: keyof SantaCruzBooking) {
  const value = booking[field];
  // Null means they did not tell us, which is a fact worth showing as one
  // rather than as an empty cell that reads like a rendering fault.
  if (value === null || value === undefined || value === "") {
    return <span className="text-gray-300">not stated</span>;
  }
  if (field === "pickupAt") return when(String(value));
  if (field === "priceCents") return money(Number(value));
  return String(value);
}

export function SantaCruzTab() {
  const [bookings, setBookings] = useState<SantaCruzBooking[]>([]);
  const [mapping, setMapping] = useState<FieldMapping[]>([]);
  const [connection, setConnection] = useState<SantaCruzConnection | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [b, m, c] = await Promise.all([
        santacruzApi.bookings(),
        santacruzApi.mapping(),
        santacruzApi.connection(),
      ]);
      setBookings(b);
      setMapping(m);
      setConnection(c);
    } catch (err) {
      setError(apiMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const shown = useMemo(() => {
    const mapped = new Set(mapping.map((m) => m.targetField));
    return COLUMNS.filter((c) => mapped.has(c.field as string));
  }, [mapping]);

  if (loading) return <p className="py-12 text-center text-sm text-gray-500">Loading…</p>;

  return (
    <div className="space-y-4">
      <ErrorNote message={error} />

      {connection && !connection.readyForFileImport && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm text-amber-900">
          <p className="font-medium">SantaCruz is not set up yet.</p>
          <p className="mt-1">
            {connection.missingRequired.length > 0
              ? `Nothing is mapped to ${connection.missingRequired.join(", ")} yet, so no booking can be read.`
              : "No mapping has been set up yet."}{" "}
            <Link to="/santacruz" className="font-medium text-amber-900 underline">
              Set up the connection →
            </Link>
          </p>
        </div>
      )}

      <Card
        title={`SantaCruz bookings${bookings.length ? ` · ${bookings.length}` : ""}`}
        action={
          <Link to="/santacruz" className="text-xs font-medium text-indigo-600 hover:text-indigo-700">
            Connection and mapping →
          </Link>
        }
      >
        {bookings.length === 0 ? (
          <Empty>
            Nothing has been imported from SantaCruz yet. These are their bookings, kept separate
            from the desk's own — the Reservations tab is unaffected.
          </Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-gray-100 bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  {shown.map((c) => (
                    <th key={String(c.field)} className="px-4 py-2 font-medium">
                      {c.label}
                    </th>
                  ))}
                  <th className="px-4 py-2 font-medium">Adam</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {bookings.map((b) => (
                  <tr key={b.id} className="hover:bg-gray-50">
                    {shown.map((c) => (
                      <td key={String(c.field)} className="whitespace-nowrap px-4 py-2 text-gray-700">
                        {cell(b, c.field)}
                      </td>
                    ))}
                    <td className="whitespace-nowrap px-4 py-2">
                      {b.ticketId ? (
                        <Link
                          to={`/tickets/${b.ticketId}`}
                          className="text-xs font-medium text-indigo-600 hover:text-indigo-700"
                        >
                          Open the ticket →
                        </Link>
                      ) : (
                        <span className="text-xs text-gray-400">no email on file</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <p className="px-1 text-xs text-gray-400">
        SantaCruz owns these bookings. Adam mirrors them to show them beside the conversation they
        arrived through, and never writes a change back.
      </p>
    </div>
  );
}

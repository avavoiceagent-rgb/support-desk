// Operations: the schedules, the partner list and the reservations.
//
// Everyone signed in can look; only an admin sees an edit control. That is the
// same split the API enforces, and the screen matching it means a dispatcher
// is never offered a button that will come back 403.
//
// The three lists — drivers, cars, partners — load once here and are handed
// down. Every tab needs them for its dropdowns, and three tabs each fetching
// the same three lists on every switch is three round trips to show a screen
// the reader has already seen.

import { useCallback, useEffect, useState } from "react";
import { opsApi, type Affiliate, type Driver, type Vehicle } from "../api/ops";
import { useAuth } from "../hooks/useAuth";
import { ScheduleTab } from "../components/ops/ScheduleTab";
import { AffiliatesTab } from "../components/ops/AffiliatesTab";
import { ReservationsTab } from "../components/ops/ReservationsTab";
import { MessagesTab } from "../components/ops/MessagesTab";
import { ErrorNote, apiMessage } from "../components/ops/shared";

type Tab = "schedule" | "affiliates" | "reservations" | "messages";

const TABS: { key: Tab; label: string }[] = [
  { key: "schedule", label: "Driver schedules" },
  { key: "affiliates", label: "Partners" },
  { key: "reservations", label: "Reservations" },
  { key: "messages", label: "Messages" },
];

export function OperationsPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "ADMIN";

  const [tab, setTab] = useState<Tab>("schedule");
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [affiliates, setAffiliates] = useState<Affiliate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [d, v, a] = await Promise.all([opsApi.drivers(), opsApi.vehicles(), opsApi.affiliates()]);
      setDrivers(d);
      setVehicles(v);
      setAffiliates(a);
    } catch (err) {
      setError(apiMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-gray-900">Operations</h1>
          <p className="mt-0.5 text-sm text-gray-500">
            {isAdmin
              ? "Rosters, partners and reservations. Changes here are live."
              : "Rosters, partners and reservations. Read only — ask an admin to make a change."}
          </p>
        </div>
        <nav className="flex gap-1.5 rounded-lg bg-gray-100 p-1">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`rounded-md px-3.5 py-1.5 text-sm font-medium transition-colors ${
                tab === t.key ? "bg-white text-gray-900 shadow-sm" : "text-gray-600 hover:text-gray-900"
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </div>

      <ErrorNote message={error} />

      {loading ? (
        <p className="py-12 text-center text-sm text-gray-500">Loading…</p>
      ) : (
        <>
          {tab === "schedule" && <ScheduleTab drivers={drivers} vehicles={vehicles} isAdmin={isAdmin} />}
          {tab === "affiliates" && (
            <AffiliatesTab affiliates={affiliates} isAdmin={isAdmin} onChanged={() => void load()} />
          )}
          {tab === "messages" && <MessagesTab drivers={drivers} affiliates={affiliates} />}
          {tab === "reservations" && (
            <ReservationsTab
              drivers={drivers}
              vehicles={vehicles}
              affiliates={affiliates}
              isAdmin={isAdmin}
            />
          )}
        </>
      )}
    </div>
  );
}

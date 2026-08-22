// The operations API, typed.
//
// Every datetime crosses the wire as an ISO string — the backend hands back
// Date objects, JSON turns them into text, and pretending otherwise is how a
// screen ends up calling .getTime() on a string. They stay strings here and
// are parsed at the point they are formatted.
//
// Three shapes the server chose that this file does not smooth over, because
// hiding them would mean guessing wrong somewhere else later:
//   - /drivers/:id/schedule is NOT wrapped; everything else is.
//   - a refusal (409, 400, 404) carries an `error` string written for a
//     dispatcher to read. It is shown verbatim, never replaced.
//   - `limit` above 200 is rejected, not clamped.

import { api } from "./client";

export type VehicleClass = "SEDAN" | "SUV" | "VAN" | "SPRINTER";
export type TripStatus = "SCHEDULED" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED" | "NO_SHOW";

export const VEHICLE_CLASSES: VehicleClass[] = ["SEDAN", "SUV", "VAN", "SPRINTER"];
export const TRIP_STATUSES: TripStatus[] = [
  "SCHEDULED",
  "IN_PROGRESS",
  "COMPLETED",
  "CANCELLED",
  "NO_SHOW",
];

/** The most reservations the server will hand over in one request. */
export const MAX_TRIP_LIMIT = 200;

export interface Vehicle {
  id: string;
  label: string;
  class: VehicleClass;
  makeModel: string;
  plate: string;
  passengerCapacity: number;
  luggageCapacity: number;
  active: boolean;
  createdAt: string;
}

export interface VehicleSummary {
  id: string;
  label: string;
  class: string;
}

export interface DriverContact {
  id: string;
  name: string;
  phone: string;
}

export interface AffiliateContact {
  id: string;
  company: string;
  phone: string;
  email: string;
}

/** A driver as the directory lists them, with the usual car joined on. */
export interface Driver {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  licenceNumber: string | null;
  active: boolean;
  notes: string | null;
  defaultVehicle: VehicleSummary | null;
}

/** The raw row, which is what a write returns and what the schedule embeds. */
export interface DriverRow {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  defaultVehicleId: string | null;
  licenceNumber: string | null;
  active: boolean;
  notes: string | null;
  createdAt: string;
}

export interface Affiliate {
  id: string;
  company: string;
  contactName: string | null;
  phone: string;
  email: string;
  coverageStates: string[];
  coverageCities: string[];
  overflowPartner: boolean;
  hourlyRateUsd: number | null;
  preference: number;
  active: boolean;
  notes: string | null;
  createdAt: string;
}

export interface Trip {
  id: string;
  reference: string;
  ticketId: string | null;
  passengerName: string;
  passengerPhone: string | null;
  bookerName: string | null;
  bookerEmail: string | null;
  pickupAddress: string;
  dropoffAddress: string;
  stops: string[];
  pickupAt: string;
  bookedHours: number;
  actualHours: number | null;
  vehicleClass: VehicleClass;
  passengerCount: number | null;
  luggageCount: number | null;
  flightNumber: string | null;
  status: TripStatus;
  assignedKind: string;
  driverId: string | null;
  vehicleId: string | null;
  affiliateId: string | null;
  farmOutReason: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  driver: DriverContact | null;
  vehicle: VehicleSummary | null;
  affiliate: AffiliateContact | null;
}

export interface Shift {
  id: string;
  startsAt: string;
  endsAt: string;
  unavailable: boolean;
  reason: string | null;
  vehicle: VehicleSummary | null;
  trips: Trip[];
}

export interface DriverSchedule {
  driver: DriverRow;
  shifts: Shift[];
  /** Trips this driver has that no shift covers. Never hidden. */
  unscheduledTrips: Trip[];
}

export interface TripSearch {
  from?: string;
  to?: string;
  status?: string;
  driverId?: string;
  affiliateId?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

export interface TripSearchResult {
  trips: Trip[];
  total: number;
}

/**
 * A yyyy-mm-dd from a date input, as the first instant of that day here.
 *
 * The server wants a full ISO datetime — a bare date is a 400 — and "here"
 * is the right zone because the person picking the date is looking at a
 * calendar on the wall in New Jersey, not at UTC.
 */
export function startOfDayIso(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0).toISOString();
}

export function endOfDayIso(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d, 23, 59, 59, 999).toISOString();
}

/** yyyy-mm-dd for a date input, in local time rather than UTC. */
export function toDateInput(value: Date | string): string {
  const d = typeof value === "string" ? new Date(value) : value;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** yyyy-mm-ddThh:mm for a datetime-local input, in local time. */
export function toDateTimeInput(value: Date | string): string {
  const d = typeof value === "string" ? new Date(value) : value;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${toDateInput(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** What a datetime-local input gives back, as a full ISO instant. */
export function fromDateTimeInput(value: string): string {
  return new Date(value).toISOString();
}

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const s = search.toString();
  return s ? `?${s}` : "";
}

export const opsApi = {
  drivers: () => api.get<{ drivers: Driver[] }>("/ops/drivers").then((r) => r.drivers),
  vehicles: () => api.get<{ vehicles: Vehicle[] }>("/ops/vehicles").then((r) => r.vehicles),
  affiliates: () => api.get<{ affiliates: Affiliate[] }>("/ops/affiliates").then((r) => r.affiliates),

  /** Unwrapped on purpose — this is what the endpoint returns. */
  schedule: (driverId: string, window: { from?: string; to?: string } = {}) =>
    api.get<DriverSchedule>(`/ops/drivers/${driverId}/schedule${query(window)}`),

  trips: (search: TripSearch = {}) =>
    api.get<TripSearchResult>(`/ops/trips${query({ ...search })}`),

  createShift: (input: {
    driverId: string;
    startsAt: string;
    endsAt: string;
    vehicleId?: string | null;
    unavailable?: boolean;
    reason?: string | null;
  }) => api.post<{ shift: unknown }>("/ops/shifts", input),

  updateShift: (
    id: string,
    patch: {
      driverId?: string;
      startsAt?: string;
      endsAt?: string;
      vehicleId?: string | null;
      unavailable?: boolean;
      reason?: string | null;
    }
  ) => api.patch<{ shift: unknown }>(`/ops/shifts/${id}`, patch),

  deleteShift: (id: string) => api.delete<void>(`/ops/shifts/${id}`),

  createAffiliate: (input: Partial<Affiliate> & { company: string; phone: string; email: string }) =>
    api.post<{ affiliate: Affiliate }>("/ops/affiliates", input),

  updateAffiliate: (id: string, patch: Partial<Affiliate>) =>
    api.patch<{ affiliate: Affiliate }>(`/ops/affiliates/${id}`, patch),

  updateTrip: (
    id: string,
    patch: {
      pickupAt?: string;
      bookedHours?: number;
      driverId?: string | null;
      vehicleId?: string | null;
      affiliateId?: string | null;
      status?: TripStatus;
      notes?: string | null;
    }
  ) => api.patch<{ trip: Trip }>(`/ops/trips/${id}`, patch),
};

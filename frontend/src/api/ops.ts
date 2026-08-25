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

/** One band of a partner's rate card: [fromMiles, toMiles) from their base. */
/**
 * `note` is a caution about operating authority, not a refusal — a partner's
 * rate card says how far they will travel, their coverage says where they are
 * licensed, and only the first of those can stop a price.
 */
export type TripQuote =
  | {
      priced: true;
      /** Straight-line miles from the partner's base to the pickup. */
      miles: number;
      quote: {
        zone: AffiliateZone;
        hourlyRateCents: number;
        requestedHours: number;
        /** What they will bill once the band's minimum is applied. */
        billableHours: number;
        totalCents: number;
      };
      note: string | null;
    }
  | { priced: false; reason: string; note: string | null };

/** Who could take a trip, and what it costs if it goes out. */
export interface TripCandidates {
  drivers: {
    driverId: string;
    name: string;
    phone: string;
    vehicleId: string | null;
    vehicleLabel: string | null;
    vehicleClass: VehicleClass | null;
    /** Trips they already have that day — context for whoever assigns. */
    tripsThatDay: number;
  }[];
  partners: {
    affiliateId: string;
    company: string;
    phone: string;
    reason: "COVERS_AREA" | "OVERFLOW";
    preference: number;
    quote: TripQuote;
  }[];
  fallbackReason: "OUT_OF_AREA" | "NO_CAR_FREE" | null;
  /** Why the list is as short as it is. Null when it explains itself. */
  coverageNote: string | null;
  /** The message that will actually be sent, written by the code that sends it. */
  offerText: string;
  /** Who holds the job now, and whether that still stands. */
  assignment: {
    kind: ContactKind;
    contactId: string;
    name: string;
    /** False when the booking changed after we last spoke to them. Null when we never have. */
    toldOfLatest: boolean | null;
    /** Null for a partner — their diary is not ours to know. */
    stillAvailable: boolean | null;
  } | null;
}

export interface AffiliateZone {
  id: string;
  affiliateId: string;
  label: string;
  fromMiles: number;
  /** null means "and everything beyond" — the band that catches the rest. */
  toMiles: number | null;
  minimumHours: number;
  /** Hourly rate in cents, per class. A class absent is one they do not run. */
  rateCents: Partial<Record<VehicleClass, number>>;
  sortOrder: number;
  createdAt: string;
}

export interface ZoneInput {
  label: string;
  fromMiles: number;
  toMiles: number | null;
  minimumHours: number;
  rateCents: Partial<Record<VehicleClass, number>>;
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
  /** Where their cars sit — what the distance bands measure from. */
  baseAddress: string | null;
  baseLat: number | null;
  baseLng: number | null;
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
  /** The flight this pickup was worked back from. Null on older bookings. */
  flightAt: string | null;
  flightKind: "DOMESTIC" | "INTERNATIONAL" | null;
  status: TripStatus;
  assignedKind: string;
  driverId: string | null;
  vehicleId: string | null;
  affiliateId: string | null;
  farmOutReason: string | null;
  /** What the partner charges us on a farmed-out job, in whole cents. */
  partnerQuoteCents: number | null;
  /** What the customer is charged for it, margin included. */
  customerPriceCents: number | null;
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

/** The columns the server will order by. Anything else is a 400. */
export type TripSort =
  | "pickupAt"
  | "reference"
  | "passengerName"
  | "bookedHours"
  | "status"
  | "driver"
  | "vehicle";

export interface TripSearch {
  from?: string;
  to?: string;
  status?: string;
  driverId?: string;
  affiliateId?: string;
  q?: string;
  sort?: TripSort;
  dir?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

export interface TripFieldChange {
  field: string;
  from: string | null;
  to: string | null;
}

/** One line of a reservation's history. Append-only on the server. */
export interface TripEvent {
  id: string;
  tripId: string;
  actorUserId: string | null;
  /** The name that person had when they made the change, not their name now. */
  actorName: string;
  kind: "CREATED" | "UPDATED" | "CANCELLED";
  changes: TripFieldChange[];
  source: string | null;
  createdAt: string;
}

export interface TripSearchResult {
  trips: Trip[];
  total: number;
}

// Dates and times belong to the operating zone, not the browser's. See
// lib/time.ts — these are re-exported so callers have one import for the API
// and the calendar it speaks in.
export {
  startOfDayIso,
  endOfDayIso,
  toDateInput,
  toDateTimeInput,
  fromDateTimeInput,
  instantFromInput,
  OPERATING_ZONE_LABEL,
} from "../lib/time";

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const s = search.toString();
  return s ? `?${s}` : "";
}

export type DispatchDirection = "OUT" | "IN";
export interface PartnerQuote {
  requestId: string;
  quoteId: string | null;
  affiliateId: string;
  company: string;
  askedAt: string;
  quotedAt: string | null;
  /** What the partner charges us, in whole cents. Null until they answer. */
  amountCents: number | null;
  /** What we charge the customer, margin included. */
  customerCents: number | null;
  awarded: boolean;
}

export type DispatchKind =
  | "OFFER"
  | "ACCEPT"
  | "DECLINE"
  | "TEXT"
  /** The reservation sent to a partner with no price, asking what they charge. */
  | "QUOTE_REQUEST"
  /** A partner's price back. Carries amountCents. */
  | "QUOTE";

export interface DispatchMessage {
  id: string;
  tripId: string | null;
  driverId: string | null;
  affiliateId: string | null;
  direction: DispatchDirection;
  kind: DispatchKind;
  body: string;
  respondsToId: string | null;
  /** Money, in whole cents, on a QUOTE or on the OFFER that awarded the job. */
  amountCents: number | null;
  /** Who at the desk sent it, on an outbound message. */
  authorName: string | null;
  /** Who was standing in for the contact, on an inbound one. */
  actedByName: string | null;
  createdAt: string;
}

export type ContactKind = "DRIVER" | "AFFILIATE";

export const dispatchApi = {
  messages: (kind: ContactKind, id: string) =>
    api
      .get<{ messages: DispatchMessage[] }>(`/dispatch/${kind}/${id}/messages`)
      .then((r) => r.messages),

  sendText: (kind: ContactKind, id: string, body: string, direction: DispatchDirection) =>
    api.post<{ message: DispatchMessage }>(`/dispatch/${kind}/${id}/messages`, { body, direction }),

  sendOffer: (kind: ContactKind, id: string, tripId: string, note?: string | null) =>
    api.post<{ message: DispatchMessage }>(`/dispatch/${kind}/${id}/offers`, { tripId, note }),

  /**
   * How many offers each contact has been sent and not yet answered.
   *
   * Keyed by contact id. An absent id means nothing outstanding.
   */
  pending: () =>
    api.get<{ drivers: Record<string, number>; affiliates: Record<string, number> }>(
      "/dispatch/pending"
    ),

  /** Tell whoever holds a job that it has changed. Not a new offer — see the server. */
  sendChangeNotice: (kind: ContactKind, id: string, tripId: string, note?: string | null) =>
    api.post<{ message: DispatchMessage }>(`/dispatch/${kind}/${id}/change-notice`, {
      tripId,
      note,
    }),

  respond: (offerId: string, accept: boolean, note?: string | null) =>
    api.post<{ message: DispatchMessage; trip: Trip | null }>(
      `/dispatch/offers/${offerId}/response`,
      { accept, note }
    ),
};

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

  tripEvents: (tripId: string) =>
    api.get<{ events: TripEvent[] }>(`/ops/trips/${tripId}/events`).then((r) => r.events),

  zones: (affiliateId: string) =>
    api.get<{ zones: AffiliateZone[] }>(`/ops/affiliates/${affiliateId}/zones`).then((r) => r.zones),

  createZone: (affiliateId: string, input: ZoneInput) =>
    api.post<{ zone: AffiliateZone }>(`/ops/affiliates/${affiliateId}/zones`, input),

  updateZone: (id: string, patch: Partial<ZoneInput>) =>
    api.patch<{ zone: AffiliateZone }>(`/ops/zones/${id}`, patch),

  deleteZone: (id: string) => api.delete<void>(`/ops/zones/${id}`),

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

  /**
   * What one partner's rate card says this job costs.
   *
   * `priced: false` always carries a sentence explaining why, because "no
   * price" and "no price because nobody has entered their card" send a
   * dispatcher to different places.
   */
  candidates: (tripId: string) => api.get<TripCandidates>(`/ops/trips/${tripId}/candidates`),

  quoteTrip: (tripId: string, affiliateId: string) =>
    api.get<TripQuote>(`/ops/trips/${tripId}/quote?affiliateId=${encodeURIComponent(affiliateId)}`),

  /**
   * The words to send the customer now this booking exists, or has moved.
   *
   * Fetched, not sent. It goes into the reply box and waits for somebody to
   * read it — the server has no path that puts it in front of a customer.
   */
  /**
   * Farming a job out: ask several partners what they charge, take one price.
   *
   * The customer's figure comes back from the server rather than being worked
   * out here. One margin, computed in one place, so a screen cannot disagree
   * with what actually gets stored on the trip.
   */
  quotes: (tripId: string) =>
    api.get<{ quotes: PartnerQuote[] }>(`/dispatch/quotes/${tripId}`).then((r) => r.quotes),

  requestQuotes: (tripId: string, affiliateIds: string[], note?: string) =>
    api.post<{ sent: unknown[]; refused: { affiliateId: string; reason: string }[] }>(
      `/dispatch/quotes/${tripId}/requests`,
      { affiliateIds, note: note ?? null }
    ),

  recordQuote: (requestId: string, amountCents: number) =>
    api.post<{ message: DispatchMessage }>(`/dispatch/quote-requests/${requestId}/quote`, {
      amountCents,
    }),

  awardQuote: (quoteId: string) =>
    api.post<{ trip: Trip }>(`/dispatch/quotes/${quoteId}/award`, {}),

  confirmation: (tripId: string, ticketId: string, form?: "NEW" | "CHANGE") =>
    api.get<{
      kind: "NEW" | "CHANGE";
      reference: string;
      bodyHtml: string;
      tellsThemAnything: boolean;
    }>(
      `/ops/trips/${tripId}/confirmation?ticketId=${encodeURIComponent(ticketId)}` +
        (form ? `&form=${form}` : "")
    ),
};

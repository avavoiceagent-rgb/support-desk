// Google Maps lookups: turning what a customer typed into a verified address
// with a postcode, and measuring how long the drive actually takes.
//
// Why this exists at all: Claude cannot look an address up. Asked to "confirm
// the postcode" it will produce a plausible one, and a plausible postcode in a
// booking confirmation is worse than none. Everything factual about addresses
// and journey times comes from here; the model only repeats it.
//
// Nothing in this module throws. A failure returns null and the caller falls
// back to asking the customer, which is what we would have done anyway.

import { env, isMapsConfigured } from "../config/env";

const GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json";
const ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes";

/** Google is normally quick; if it isn't, we'd rather draft without it. */
const REQUEST_TIMEOUT_MS = 8000;

export interface VerifiedAddress {
  /** Google's tidy version, e.g. "245 Park Ave, New York, NY 10167, USA". */
  formattedAddress: string;
  /** Null for places that genuinely have no postcode, airports included. */
  postalCode: string | null;
  placeId: string;
  isAirport: boolean;
  /**
   * True when Google wasn't confident it matched what was asked for — the
   * caller should treat the result as a suggestion and have Adam ask.
   */
  partialMatch: boolean;
  /** What the customer originally wrote, kept so Adam can quote it back. */
  query: string;
}

export interface RouteEstimate {
  minutes: number;
  miles: number;
}

export function isMapsEnabled(): boolean {
  return isMapsConfigured;
}

async function getJson(url: string, init?: RequestInit): Promise<unknown | null> {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok) {
      console.error(`[maps] ${response.status} from ${new URL(url).pathname}`);
      return null;
    }
    return await response.json();
  } catch (err) {
    console.error("[maps] request failed:", err);
    return null;
  }
}

interface GeocodeComponent {
  long_name?: string;
  short_name?: string;
  types?: string[];
}

interface GeocodeResult {
  formatted_address?: string;
  place_id?: string;
  types?: string[];
  partial_match?: boolean;
  address_components?: GeocodeComponent[];
}

/** Exported for tests: turns Google's response into our own shape. */
export function parseGeocodeResponse(raw: unknown, query: string): VerifiedAddress | null {
  if (!raw || typeof raw !== "object") return null;
  const body = raw as { status?: string; results?: GeocodeResult[]; error_message?: string };

  if (body.status !== "OK") {
    // ZERO_RESULTS is a normal answer to a vague address; the rest mean the
    // key or the project is misconfigured and someone needs to know.
    if (body.status && body.status !== "ZERO_RESULTS") {
      console.error(`[maps] geocode status ${body.status}${body.error_message ? `: ${body.error_message}` : ""}`);
    }
    return null;
  }

  const top = body.results?.[0];
  if (!top?.formatted_address || !top.place_id) return null;

  const postalCode =
    top.address_components?.find((c) => c.types?.includes("postal_code"))?.long_name ?? null;

  return {
    formattedAddress: top.formatted_address,
    postalCode,
    placeId: top.place_id,
    // Airports don't need a postcode confirmed — the terminal is the address.
    isAirport: Boolean(top.types?.includes("airport")),
    partialMatch: Boolean(top.partial_match),
    query,
  };
}

/**
 * Look up one address. Returns null when maps are switched off, when Google
 * doesn't recognise it, or when the call fails.
 */
export async function verifyAddress(query: string): Promise<VerifiedAddress | null> {
  if (!isMapsConfigured || !query.trim()) return null;
  const url = `${GEOCODE_URL}?address=${encodeURIComponent(query)}&region=us&key=${encodeURIComponent(env.GOOGLE_MAPS_API_KEY)}`;
  return parseGeocodeResponse(await getJson(url), query);
}

/** Exported for tests: reads the duration and distance out of a Routes reply. */
export function parseRouteResponse(raw: unknown): RouteEstimate | null {
  if (!raw || typeof raw !== "object") return null;
  const body = raw as { routes?: { duration?: string; distanceMeters?: number }[] };
  const route = body.routes?.[0];
  if (!route?.duration) return null;

  // Routes returns a protobuf duration string like "3600s".
  const seconds = Number.parseInt(String(route.duration).replace(/s$/, ""), 10);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;

  return {
    minutes: Math.round(seconds / 60),
    miles: Math.round(((route.distanceMeters ?? 0) / 1609.344) * 10) / 10,
  };
}

/**
 * Driving time from pickup to drop-off, via any stops, in traffic.
 *
 * `departureTime` must be in the future for Google to model traffic; when it
 * isn't (or isn't known) we omit it and get current conditions instead, which
 * is still far better than a guess.
 */
export async function estimateRoute(params: {
  originPlaceId: string;
  destinationPlaceId: string;
  viaPlaceIds?: string[];
  departureTime?: Date | null;
}): Promise<RouteEstimate | null> {
  if (!isMapsConfigured) return null;

  const departureInFuture =
    params.departureTime instanceof Date && params.departureTime.getTime() > Date.now() + 60_000;

  const body = {
    origin: { placeId: params.originPlaceId },
    destination: { placeId: params.destinationPlaceId },
    intermediates: (params.viaPlaceIds ?? []).map((placeId) => ({ placeId })),
    travelMode: "DRIVE",
    routingPreference: "TRAFFIC_AWARE",
    ...(departureInFuture ? { departureTime: params.departureTime!.toISOString() } : {}),
  };

  return parseRouteResponse(
    await getJson(ROUTES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": env.GOOGLE_MAPS_API_KEY,
        "X-Goog-FieldMask": "routes.duration,routes.distanceMeters",
      },
      body: JSON.stringify(body),
    })
  );
}

/**
 * How an address should read in Adam's email. Airports keep their name; other
 * addresses get the postcode Google returned, and anything unverified is
 * quoted back exactly as the customer wrote it so nothing is invented.
 */
export function describeAddress(verified: VerifiedAddress | null, fallback: string): string {
  if (!verified) return fallback;
  return verified.formattedAddress;
}

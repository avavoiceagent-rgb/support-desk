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
  /** US state code, e.g. "NY". Null when Google didn't return one. */
  state: string | null;
  /**
   * True when Google wasn't confident it matched what was asked for — the
   * caller should treat the result as a suggestion and have Adam ask.
   */
  partialMatch: boolean;
  /** What the customer originally wrote, kept so Adam can quote it back. */
  query: string;
  /**
   * Where the place actually is.
   *
   * Google returns this on every geocode and we used to drop it, which left
   * the rate cards — priced by distance from a partner's base — with no way
   * to measure the distance. Null only when a response somehow arrives
   * without a location, which Google's own contract says should not happen.
   */
  lat: number | null;
  lng: number | null;
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

/**
 * Google types a whole airport as "airport", but a specific TERMINAL comes
 * back as an ordinary point of interest — "JFK Terminal 4" resolves to
 * "Terminal 4, Terminal 4 Departures, Jamaica, NY 11430, USA" with no airport
 * type at all. Found by running a real lookup; no amount of mocking would
 * have shown it. Missing it means asking a customer to confirm the postcode
 * of JFK, and the airport lead-time rules never firing on a terminal drop-off.
 */
const AIRPORT_TEXT = /\bairport\b|\bterminal\s*\d|\b(?:jfk|lga|ewr|hpn|swf|isp|teb)\b/i;

export function looksLikeAirport(types: string[] | undefined, formattedAddress: string, query: string): boolean {
  if (types?.includes("airport")) return true;
  return AIRPORT_TEXT.test(formattedAddress) || AIRPORT_TEXT.test(query);
}

interface GeocodeResult {
  formatted_address?: string;
  place_id?: string;
  types?: string[];
  partial_match?: boolean;
  address_components?: GeocodeComponent[];
  geometry?: { location?: { lat?: number; lng?: number } };
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
  const state =
    top.address_components?.find((c) => c.types?.includes("administrative_area_level_1"))?.short_name ??
    null;

  // Checked rather than cast: a string "40.7" or a missing pair would sail
  // through the type assertion and become a distance measured from nowhere.
  const rawLat = top.geometry?.location?.lat;
  const rawLng = top.geometry?.location?.lng;
  const hasPoint = typeof rawLat === "number" && typeof rawLng === "number";

  return {
    formattedAddress: top.formatted_address,
    postalCode,
    state,
    placeId: top.place_id,
    lat: hasPoint ? rawLat : null,
    lng: hasPoint ? rawLng : null,
    // Airports don't need a postcode confirmed — the terminal is the address.
    isAirport: looksLikeAirport(top.types, top.formatted_address, query),
    partialMatch: Boolean(top.partial_match),
    query,
  };
}

/**
 * Look up one address. Returns null when maps are switched off, when Google
 * doesn't recognise it, or when the call fails.
 */
/**
 * The corner of the world this company actually drives in.
 *
 * Roughly Trenton up to Poughkeepsie and Allentown across to Montauk — wide
 * enough to hold every airport, every borough and the whole of New Jersey,
 * and nowhere near wide enough to hold Oklahoma.
 *
 * A bias, not a restriction, and the distinction is the whole point: an
 * ambiguous name resolves near home, and an unambiguous Philadelphia or
 * Boston still resolves where it actually is. Restricting to the area would
 * break every out-of-area job the partner network exists to cover.
 */
const SERVICE_AREA_VIEWPORT = { south: 40.0, west: -75.6, north: 41.8, east: -71.8 };

export function buildGeocodeUrl(query: string, key: string): string {
  // `components=country:US` RESTRICTS the search; `region=us` only biases it.
  // Without the restriction Google answered "LaGuardia" with Laguardia in
  // Álava, Spain — which put a Spanish town in a customer's drop-off line and,
  // because Álava is not NY or NJ, flagged a Manhattan airport run as a trip
  // outside the service area. This company drives in the United States.
  //
  // One country was not enough. "JFK" then came back as John F. Kennedy in
  // Oklahoma City — inside the restriction, 1,400 miles from the airport the
  // customer meant, and it reached them in an email. `bounds` biases the
  // search towards the viewport we work in, which is what makes a bare
  // airport code resolve in Queens.
  const { south, west, north, east } = SERVICE_AREA_VIEWPORT;
  const params = new URLSearchParams({
    address: query,
    components: "country:US",
    region: "us",
    bounds: `${south},${west}|${north},${east}`,
    key,
  });
  return `${GEOCODE_URL}?${params.toString()}`;
}

export async function verifyAddress(query: string): Promise<VerifiedAddress | null> {
  if (!isMapsConfigured || !query.trim()) return null;
  return parseGeocodeResponse(await getJson(buildGeocodeUrl(query, env.GOOGLE_MAPS_API_KEY)), query);
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
 * Is this journey one our own drivers cover, decided from the geocoded states
 * rather than from a model's reading of the email.
 *
 * This exists because the model got it wrong on the most common trip there is:
 * asked about Manhattan to JFK it answered EXTERNAL, reasoning that "the trip
 * ends at JFK Terminal 4, which is outside our service area" — the opposite of
 * what it had been told. A state code from Google is not a matter of opinion.
 *
 * Returns null when we could not verify enough to say, so the label is left
 * for a person rather than guessed.
 */
export function resolveServiceArea(
  points: (VerifiedAddress | null)[],
  serviceAreaStates: string[]
): "INTERNAL" | "EXTERNAL" | null {
  const known = points.filter((p): p is VerifiedAddress => p !== null && p.state !== null);
  // Every leg has to be accounted for; one unverified address could be anywhere.
  if (known.length === 0 || known.length !== points.length) return null;
  return known.every((p) => serviceAreaStates.includes(p.state as string)) ? "INTERNAL" : "EXTERNAL";
}

/**
 * Google's formatted_address is built for machines. It repeats the place name
 * in front of the street ("245 Park Avenue, 245 Park Ave, New York, NY 10167,
 * USA") and always appends the country, which reads badly in an email to a
 * customer standing in New York.
 *
 * This drops a leading name that merely repeats what follows, and the country
 * suffix. A leading name that adds something — a hotel, a building a driver
 * would look for — is kept, because that is useful at the kerb.
 */
/**
 * How much longer one part may be than the other and still count as the same
 * thing said twice.
 *
 * "245 Park Avenue, 245 Park Ave" differ by three characters — an abbreviation,
 * and the repetition this exists to remove. "Newark Liberty International
 * Airport (EWR), Newark" differ by twenty-nine, and they are not the same
 * thing at all: one is an airport, the other is the city it stands in.
 *
 * A bare prefix test could not tell them apart, and on 25 August it told a
 * customer their car was taking them to "Newark, NJ 07114" — a postcode
 * instead of the airport. The reservation had the airport all along; only the
 * sentence the customer read had lost it.
 */
const SAME_PLACE_SLACK = 5;

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/i).filter(Boolean));

/**
 * Is everything the first part says already said by the second?
 *
 * The only safe reason to delete the leading name is that deleting it loses
 * nothing. Two ways that can be true: every word of it reappears in the line
 * after ("Terminal 4" inside "Terminal 4 Departures"), or the two are the same
 * words with one abbreviated ("245 Park Avenue" and "245 Park Ave").
 */
function saysNothingNew(first: string, second: string): boolean {
  const a = squash(first);
  const b = squash(second);
  if (!a) return false;

  const mine = words(first);
  const theirs = words(second);
  if (mine.size > 0 && [...mine].every((w) => theirs.has(w))) return true;

  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return longer.startsWith(shorter) && longer.length - shorter.length <= SAME_PLACE_SLACK;
}

export function tidyAddress(formatted: string): string {
  const withoutCountry = formatted.replace(/,\s*(?:USA|United States)\s*$/i, "").trim();
  const parts = withoutCountry.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return withoutCountry;

  return (saysNothingNew(parts[0], parts[1]) ? parts.slice(1) : parts).join(", ");
}

/**
 * How an address should read in Adam's email. Anything unverified is quoted
 * back exactly as the customer wrote it, so nothing is invented.
 */
export function describeAddress(verified: VerifiedAddress | null, fallback: string): string {
  if (!verified) return fallback;
  return tidyAddress(verified.formattedAddress);
}

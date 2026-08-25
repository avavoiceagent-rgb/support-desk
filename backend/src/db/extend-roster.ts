// Keeping the fleet on the road, and the map covered.
//
// `seed-ops.ts` builds a whole world from nothing and refuses to run twice
// without `--reset`, which deletes every trip. That is right for setting up a
// fresh database and useless for one already in use: the seeded rota runs 30
// days back and 14 days forward from the day it was run, so a few weeks later
// every test booking falls off the end of the rota and farms out to a partner
// for want of a shift. It looks exactly like a driver shortage. It is not one
// — the drivers are there, nobody is rostered.
//
// So this is the additive twin. It only ever inserts, never deletes, and every
// part of it is safe to run again: a driver who already has Tuesday keeps the
// Tuesday they have, a partner already on the books is left alone.
//
//   npm run roster:extend                 # 90 days of rota, plus fleet and partners
//   npm run roster:extend -- --days 180   # further out
//   npm run roster:extend -- --no-fleet   # rota and partners only
//
// It touches drivers, vehicles, shifts, partners and rate cards. It does not
// touch trips, invoices, tickets or messages.

import { asc, inArray } from "drizzle-orm";
import { DateTime } from "luxon";
import { db } from "./client";
import { affiliateZones, affiliates, driverShifts, drivers, vehicles } from "./schema";
import { OPERATING_TIME_ZONE } from "../booking/pickup-time";
import { SHIFT_HOURS, homeHourFor, rateCardFor, restDays } from "./seed-ops";

/** How far ahead the rota runs when nobody says otherwise. */
const DEFAULT_DAYS = 90;

// --- More cars, and more people to drive them -------------------------------
//
// The fleet was thin at the top. Sixteen drivers over fourteen cars, handed out
// one each by position, left exactly one driver for each van and one for each
// sprinter. A driver works eleven hours, five days in seven, so a single-driver
// van is available about a third of the week — and the other two thirds, a van
// booking finds no van and goes to a partner. Nothing on the screen says why.
//
// These pair up so that no van or sprinter has fewer than two drivers, which is
// what makes the big cars reachable at the hour somebody actually rings.

const EXTRA_VEHICLES = [
  { label: "Sedan 5", class: "SEDAN", makeModel: "Mercedes E-Class", plate: "T512359C", passengerCapacity: 3, luggageCapacity: 3 },
  { label: "Sedan 6", class: "SEDAN", makeModel: "BMW 5 Series", plate: "T512360C", passengerCapacity: 3, luggageCapacity: 3 },
  { label: "SUV 7", class: "SUV", makeModel: "Cadillac Escalade", plate: "T512361C", passengerCapacity: 6, luggageCapacity: 6 },
  { label: "SUV 8", class: "SUV", makeModel: "Lincoln Navigator", plate: "T512362C", passengerCapacity: 6, luggageCapacity: 6 },
  { label: "Van 3", class: "VAN", makeModel: "Mercedes Metris", plate: "T512363C", passengerCapacity: 7, luggageCapacity: 7 },
  { label: "Van 4", class: "VAN", makeModel: "Ford Transit", plate: "T512364C", passengerCapacity: 7, luggageCapacity: 7 },
  { label: "Sprinter 3", class: "SPRINTER", makeModel: "Mercedes Sprinter", plate: "T512365C", passengerCapacity: 14, luggageCapacity: 14 },
  { label: "Sprinter 4", class: "SPRINTER", makeModel: "Mercedes Sprinter", plate: "T512366C", passengerCapacity: 14, luggageCapacity: 14 },
] as const;

/**
 * New driver, and the car they take out.
 *
 * Which car matters more than it looks. The seeded fleet handed cars out by
 * position, one each, which left exactly one driver for each van and one for
 * each sprinter. A driver works eleven hours, five days in seven, so a
 * single-driver van is on the road about a third of the week — and the other
 * two thirds, a van booking finds no van and farms out with nothing on the
 * screen to say why. Worse for sprinters: both their drivers drew morning
 * starts, so every sprinter was off the road by five in the afternoon and a
 * 9pm booking for fourteen people found nothing, every single day.
 *
 * What hour each of these starts is not written here — see `spreadStartHours`,
 * which works it out from the gaps the existing rota leaves.
 */
const EXTRA_DRIVERS = [
  { name: "Elias Farrow", vehicle: "Van 3" },
  { name: "Nikola Jovanović", vehicle: "Van 4" },
  { name: "Omar Benali", vehicle: "Van 1" },
  { name: "Grace Mbeki", vehicle: "Van 2" },
  { name: "Viktor Horvat", vehicle: "Sprinter 3" },
  { name: "Danilo Ferreira", vehicle: "Sprinter 4" },
  { name: "Aleksandr Volkov", vehicle: "Sprinter 1" },
  { name: "Marta Kowalczyk", vehicle: "Sprinter 2" },
  // Six sprinter drivers rather than four, and it took measuring to find that
  // out. The two the seed made both drew morning starts, and nothing that can
  // be done with the rest is enough to cover the other sixteen hours of the
  // day five days a week — four extras still left a sprinter booking finding
  // nobody about one time in ten.
  { name: "Bojan Ilić", vehicle: "Sprinter 3" },
  { name: "Theo Lambert", vehicle: "Sprinter 4" },
  { name: "Nadia Haddad", vehicle: "SUV 7" },
  { name: "Colm Brennan", vehicle: "SUV 8" },
  { name: "Femi Adeyemi", vehicle: "SUV 1" },
  { name: "Ravi Chandran", vehicle: "Sedan 5" },
  { name: "Stefan Novak", vehicle: "Sedan 6" },
] as const;

// --- Filling the gaps rather than guessing at them --------------------------
//
// An eleven-hour shift does not cover eleven hours of work. A three-hour job
// needs the driver on from about an hour before the pickup until about four
// hours after it, so a shift starting at h is only usable for pickups from
// h+1 to h+7 — seven hours, not eleven. That is why hand-picked start times
// kept leaving holes: the arithmetic is not the arithmetic anyone does in
// their head, and neither is the effect of a rest day.
//
// So both are computed, over the whole week at once. Each new driver takes the
// start time and pair of days off that do the most for whichever hour of
// whichever day their class of car is thinnest on — which is the question a
// dispatcher actually asks: at four on a Wednesday morning, is there a
// sprinter.

/** Pickup hours a shift can actually take, counting from the hour after it starts. */
const USABLE_HOURS = 7;

/** Hours in a week: the grid everything below is scored on. */
const WEEK_HOURS = 7 * 24;

/** What a driver works: the hour they start, and their two days off. */
export interface Pattern {
  homeHour: number;
  rest: [number, number];
}

/** The hours of the week one driver's pattern can take a pickup in. */
function hoursCovered(pattern: Pattern): number[] {
  const hours: number[] = [];
  for (let weekday = 1; weekday <= 7; weekday++) {
    if (weekday === pattern.rest[0] || weekday === pattern.rest[1]) continue;
    const start = (weekday - 1) * 24 + pattern.homeHour;
    // Modulo the week, because a Sunday night shift runs into Monday.
    for (let n = 1; n <= USABLE_HOURS; n++) hours.push((start + n) % WEEK_HOURS);
  }
  return hours;
}

/** How many drivers can take a pickup in each hour of the week. */
function coverageFrom(patterns: Pattern[]): number[] {
  const cover = new Array(WEEK_HOURS).fill(0);
  for (const pattern of patterns) {
    for (const hour of hoursCovered(pattern)) cover[hour] += 1;
  }
  return cover;
}

/**
 * Is `a` a better spread of cover than `b`?
 *
 * Both are the week's hourly cover figures sorted thinnest first, and they are
 * compared in that order: whichever does more for the worst hour wins, and if
 * they tie there, for the second worst, and so on.
 *
 * Comparing only the single worst hour was the first attempt and it did
 * nothing at all. Two van drivers cover fourteen hours between them, so a
 * third still leaves the week full of holes whatever they do — every candidate
 * scored "worst hour: zero", the comparison called them all equal, and every
 * new driver was handed midnight. Six people, one start time, and eighteen
 * hours of the day with no van on the road.
 */
function betterSpread(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

/**
 * Patterns for `count` new drivers, given what their class already works.
 *
 * Greedy and deterministic: one driver at a time, each taking whichever of the
 * five hundred-odd combinations of start hour and rest days improves the
 * week's thinnest hours most, ties going to the earlier hour. Not provably the
 * best rota, and it does not need to be — it needs to leave no hour of the
 * week with nobody on it, which the test checks by asking the real
 * availability query rather than by trusting this.
 */
export function spreadShifts(existing: Pattern[], count: number): Pattern[] {
  const chosen: Pattern[] = [];

  for (let n = 0; n < count; n++) {
    let best: Pattern = { homeHour: 0, rest: [1, 2] };
    let bestCover: number[] | null = null;

    for (let hour = 0; hour < 24; hour++) {
      for (let first = 1; first <= 7; first++) {
        for (let second = first + 1; second <= 7; second++) {
          const candidate: Pattern = { homeHour: hour, rest: [first, second] };
          const cover = coverageFrom([...existing, ...chosen, candidate]).sort((x, y) => x - y);
          if (!bestCover || betterSpread(cover, bestCover)) {
            bestCover = cover;
            best = candidate;
          }
        }
      }
    }
    chosen.push(best);
  }

  return chosen;
}

// --- More of the map --------------------------------------------------------
//
// A trip that leaves NY/NJ is only answerable if somebody covers where it is
// going. The seeded book had thirteen states and DC, which is fine until a
// customer asks for Oklahoma City — as one did — and the desk has nobody to ask
// at all. That is a different failure from "the partners quoted high", and it
// is the one that stops a test dead.
//
// Between these and the seeded ones, every US state is covered by at least one
// partner. Several are covered by two on purpose: a rate request that can only
// go to one company is not really a rate request, and the quote workflow needs
// somebody to lose.
//
// Hawaii and Alaska are here for completeness rather than because anyone drives
// there. They are real markets a New York desk occasionally has to book into,
// and having them means no test falls off the edge of the map.

const EXTRA_AFFILIATES = [
  { company: "Lone Star Executive", baseAddress: "Dallas, TX", baseLat: 32.7767, baseLng: -96.797, contactName: "Wade Chalmers", phone: "+1 214 555 0102", email: "dispatch@lonestarexec.example", coverageStates: ["TX", "OK", "AR"], coverageCities: ["Dallas", "Houston", "Austin", "San Antonio", "Oklahoma City"], overflowPartner: false, hourlyRateUsd: 82, preference: 1, notes: "Texas and the near southwest. Quick on rate requests." },
  { company: "Peachtree Chauffeur Group", baseAddress: "Atlanta, GA", baseLat: 33.749, baseLng: -84.388, contactName: "Loretta Simms", phone: "+1 404 555 0117", email: "ops@peachtreechauffeur.example", coverageStates: ["GA", "AL", "SC", "TN"], coverageCities: ["Atlanta", "Birmingham", "Charleston", "Nashville"], overflowPartner: false, hourlyRateUsd: 78, preference: 2, notes: "Atlanta base. Strong on Hartsfield." },
  { company: "Carolina Coast Livery", baseAddress: "Charlotte, NC", baseLat: 35.2271, baseLng: -80.8431, contactName: "Marcus Teague", phone: "+1 704 555 0193", email: "bookings@carolinacoastlivery.example", coverageStates: ["NC", "SC", "VA"], coverageCities: ["Charlotte", "Raleigh", "Richmond", "Charleston"], overflowPartner: false, hourlyRateUsd: 76, preference: 2, notes: "The Carolinas and into Virginia." },
  { company: "Great Lakes Executive", baseAddress: "Detroit, MI", baseLat: 42.3314, baseLng: -83.0458, contactName: "Deborah Reilly", phone: "+1 313 555 0128", email: "dispatch@greatlakesexec.example", coverageStates: ["MI", "OH", "IN"], coverageCities: ["Detroit", "Cleveland", "Columbus", "Indianapolis"], overflowPartner: false, hourlyRateUsd: 74, preference: 2, notes: "Midwest industrial corridor." },
  { company: "Twin Cities Livery", baseAddress: "Minneapolis, MN", baseLat: 44.9778, baseLng: -93.265, contactName: "Erik Lindqvist", phone: "+1 612 555 0166", email: "ops@twincitieslivery.example", coverageStates: ["MN", "WI", "IA", "ND", "SD"], coverageCities: ["Minneapolis", "Saint Paul", "Milwaukee", "Des Moines", "Fargo"], overflowPartner: false, hourlyRateUsd: 72, preference: 3, notes: "Upper midwest. Winter surcharges apply — always ask." },
  { company: "Gateway Car Service", baseAddress: "St. Louis, MO", baseLat: 38.627, baseLng: -90.1994, contactName: "Anita Ruiz", phone: "+1 314 555 0151", email: "dispatch@gatewaycarservice.example", coverageStates: ["MO", "KS", "NE", "KY"], coverageCities: ["St. Louis", "Kansas City", "Omaha", "Louisville"], overflowPartner: false, hourlyRateUsd: 70, preference: 3, notes: "Central states." },
  { company: "Mile High Chauffeurs", baseAddress: "Denver, CO", baseLat: 39.7392, baseLng: -104.9903, contactName: "Josh Trelawney", phone: "+1 303 555 0184", email: "ops@milehighchauffeurs.example", coverageStates: ["CO", "UT", "WY", "NM"], coverageCities: ["Denver", "Boulder", "Salt Lake City", "Albuquerque", "Aspen"], overflowPartner: false, hourlyRateUsd: 88, preference: 2, notes: "Mountain west. Ski season books out early." },
  { company: "Desert Sky Transportation", baseAddress: "Phoenix, AZ", baseLat: 33.4484, baseLng: -112.074, contactName: "Rosa Delgado", phone: "+1 602 555 0139", email: "reservations@desertskytrans.example", coverageStates: ["AZ", "NV"], coverageCities: ["Phoenix", "Scottsdale", "Tucson", "Las Vegas"], overflowPartner: false, hourlyRateUsd: 80, preference: 2, notes: "Phoenix and Vegas." },
  { company: "Emerald City Executive", baseAddress: "Seattle, WA", baseLat: 47.6062, baseLng: -122.3321, contactName: "Trevor Lund", phone: "+1 206 555 0175", email: "dispatch@emeraldcityexec.example", coverageStates: ["WA", "OR", "ID", "MT"], coverageCities: ["Seattle", "Bellevue", "Portland", "Boise"], overflowPartner: false, hourlyRateUsd: 92, preference: 2, notes: "Pacific northwest." },
  { company: "Bay Area Premier", baseAddress: "San Francisco, CA", baseLat: 37.7749, baseLng: -122.4194, contactName: "Michelle Tran", phone: "+1 415 555 0108", email: "ops@bayareapremier.example", coverageStates: ["CA", "NV"], coverageCities: ["San Francisco", "San Jose", "Oakland", "Napa", "Palo Alto"], overflowPartner: false, hourlyRateUsd: 110, preference: 2, notes: "Northern California — the second California partner, so LA work can be quoted twice." },
  { company: "Bayou Executive Cars", baseAddress: "New Orleans, LA", baseLat: 29.9511, baseLng: -90.0715, contactName: "Etienne Broussard", phone: "+1 504 555 0146", email: "bookings@bayouexeccars.example", coverageStates: ["LA", "MS", "AL"], coverageCities: ["New Orleans", "Baton Rouge", "Jackson", "Mobile"], overflowPartner: false, hourlyRateUsd: 74, preference: 3, notes: "Gulf coast." },
  { company: "Granite State Livery", baseAddress: "Manchester, NH", baseLat: 42.9956, baseLng: -71.4548, contactName: "Sheila Barnaby", phone: "+1 603 555 0122", email: "ops@granitestatelivery.example", coverageStates: ["NH", "VT", "ME"], coverageCities: ["Manchester", "Portland", "Burlington", "Portsmouth"], overflowPartner: false, hourlyRateUsd: 78, preference: 2, notes: "Northern New England. Will meet at Logan." },
  { company: "Allegheny Executive", baseAddress: "Pittsburgh, PA", baseLat: 40.4406, baseLng: -79.9959, contactName: "Frank Kubiak", phone: "+1 412 555 0159", email: "dispatch@alleghenyexec.example", coverageStates: ["PA", "WV", "OH"], coverageCities: ["Pittsburgh", "Morgantown", "Youngstown"], overflowPartner: false, hourlyRateUsd: 70, preference: 3, notes: "Western Pennsylvania — Liberty Bell does not come this far west." },
  { company: "Aloha Island Transport", baseAddress: "Honolulu, HI", baseLat: 21.3069, baseLng: -157.8583, contactName: "Kai Nakamura", phone: "+1 808 555 0113", email: "reservations@alohaislandtransport.example", coverageStates: ["HI"], coverageCities: ["Honolulu", "Kailua", "Lahaina"], overflowPartner: false, hourlyRateUsd: 96, preference: 3, notes: "Hawaii. Book a day ahead — the island fleet is small." },
  { company: "Last Frontier Car Service", baseAddress: "Anchorage, AK", baseLat: 61.2181, baseLng: -149.9003, contactName: "Dale Ostrander", phone: "+1 907 555 0191", email: "ops@lastfrontiercar.example", coverageStates: ["AK"], coverageCities: ["Anchorage", "Fairbanks"], overflowPartner: false, hourlyRateUsd: 98, preference: 4, notes: "Alaska. Rarely needed; confirm the vehicle can take the weather." },
  // One more overflow partner at home. Three was thin for a quote request: with
  // Five Boroughs on sedans only, an SUV overflow job could be asked of exactly
  // two companies, and if one was busy the board showed a single tick box.
  { company: "Empire Reserve Livery", baseAddress: "Brooklyn, NY", baseLat: 40.6782, baseLng: -73.9442, contactName: "Sonia Vasquez", phone: "+1 347 555 0164", email: "dispatch@empirereserve.example", coverageStates: ["NY", "NJ", "CT"], coverageCities: ["New York", "Brooklyn", "Newark", "Stamford", "White Plains"], overflowPartner: true, hourlyRateUsd: 74, preference: 2, notes: "Overflow. Full range of cars including sprinters, which the other overflow partners do not run." },
] as const;

export interface ExtendSummary {
  vehiclesAdded: number;
  driversAdded: number;
  affiliatesAdded: number;
  rateBandsAdded: number;
  shiftsAdded: number;
  rosteredThrough: string;
}

/** Enough shifts for "the day they are usually off" to mean anything. */
const ENOUGH_HISTORY = 10;

/**
 * The hour a driver usually starts, read off the shifts they already have.
 *
 * Averaged around the clock rather than by picking the commonest hour, and the
 * difference matters. The seed nudges each start by up to an hour either way
 * so the rota does not read like a machine wrote it, which leaves a driver's
 * history split roughly evenly between three hours — so the commonest one is a
 * coin toss. A sprinter driver whose 6am came back as 5am finished an hour
 * earlier every day, and every early-afternoon sprinter booking for the next
 * two months found nobody.
 *
 * Hours are angles, not numbers: 23 and 1 average to midnight, not to noon.
 */
function usualStartHour(history: DateTime[]): number {
  let x = 0;
  let y = 0;
  for (const at of history) {
    const angle = (2 * Math.PI * (at.hour + at.minute / 60)) / 24;
    x += Math.cos(angle);
    y += Math.sin(angle);
  }
  const mean = (Math.atan2(y, x) * 24) / (2 * Math.PI);
  return (Math.round(mean) + 24) % 24;
}

/** The two weekdays they are off, which the drift does not touch. */
function usualRestDays(history: DateTime[]): [number, number] {
  const worked = new Map<number, number>();
  for (const at of history) worked.set(at.weekday, (worked.get(at.weekday) ?? 0) + 1);

  const quietest = [1, 2, 3, 4, 5, 6, 7]
    .map((weekday) => [weekday, worked.get(weekday) ?? 0] as const)
    // Ties by the earlier weekday, so two runs agree.
    .sort((a, b) => a[1] - b[1] || a[0] - b[0]);

  return [quietest[0][0], quietest[1][0]];
}

/**
 * What every driver works, so the rota carries on rather than starting again.
 *
 * Three cases, in order:
 *
 *  - Somebody with a history works what they have been working. This is the
 *    normal case and the important one: a driver who has been on nights all
 *    month goes on being on nights.
 *  - A driver this tool is adding takes the hour that does the most for the
 *    thinnest hour of their own class of car — see `spreadStartHours`.
 *  - Anybody else falls back to the seeded spread by position.
 *
 * The order the drivers arrive in cannot be relied on — the seed inserts them
 * in one statement, so they all share a creation time and come back in
 * whatever order the database likes. That is exactly why the hour is read from
 * the shifts rather than from a position in a list.
 */
export function patternsFor(
  ordered: { id: string; name: string; defaultVehicleId: string | null }[],
  history: Map<string, DateTime[]>,
  classOf: Map<string, string>
): Map<string, Pattern> {
  const patterns = new Map<string, Pattern>();
  const takenByClass = new Map<string, Pattern[]>();

  const note = (driver: { id: string; defaultVehicleId: string | null }, pattern: Pattern) => {
    patterns.set(driver.id, pattern);
    const cls = driver.defaultVehicleId ? classOf.get(driver.defaultVehicleId) : undefined;
    if (cls) takenByClass.set(cls, [...(takenByClass.get(cls) ?? []), pattern]);
  };

  const undecided: typeof ordered = [];
  for (const driver of ordered) {
    const worked = history.get(driver.id) ?? [];
    if (worked.length >= ENOUGH_HISTORY) {
      note(driver, { homeHour: usualStartHour(worked), rest: usualRestDays(worked) });
    } else {
      // Held back so the gap-filling below sees the whole of the existing rota
      // before it picks anything.
      undecided.push(driver);
    }
  }

  // In the order they are listed at the top of this file, so two runs of this
  // hand the same people the same shifts.
  const wanted = new Map(EXTRA_DRIVERS.map((d, n) => [d.name as string, n]));
  undecided.sort((a, b) => (wanted.get(a.name) ?? Infinity) - (wanted.get(b.name) ?? Infinity));

  for (const driver of undecided) {
    const position = ordered.indexOf(driver);
    const cls = driver.defaultVehicleId ? classOf.get(driver.defaultVehicleId) : undefined;

    note(
      driver,
      cls && wanted.has(driver.name)
        ? spreadShifts(takenByClass.get(cls) ?? [], 1)[0]
        : { homeHour: homeHourFor(position), rest: restDays(position) }
    );
  }

  return patterns;
}

export async function extendRoster(
  options: { days?: number; fleet?: boolean; partners?: boolean } = {}
): Promise<ExtendSummary> {
  const days = options.days ?? DEFAULT_DAYS;
  const addFleet = options.fleet ?? true;
  const addPartners = options.partners ?? true;

  const summary: ExtendSummary = {
    vehiclesAdded: 0,
    driversAdded: 0,
    affiliatesAdded: 0,
    rateBandsAdded: 0,
    shiftsAdded: 0,
    rosteredThrough: "",
  };

  // --- Cars ---------------------------------------------------------------
  const existingVehicles = await db.select().from(vehicles);
  const vehicleByLabel = new Map(existingVehicles.map((v) => [v.label, v]));

  if (addFleet) {
    const missing = EXTRA_VEHICLES.filter((v) => !vehicleByLabel.has(v.label));
    if (missing.length) {
      const added = await db.insert(vehicles).values(missing.map((v) => ({ ...v }))).returning();
      for (const v of added) vehicleByLabel.set(v.label, v);
      summary.vehiclesAdded = added.length;
    }
  }

  // --- Drivers ------------------------------------------------------------
  //
  // Phone, email and licence follow the same shape the seed uses, numbered on
  // from where it stopped, so the fleet reads as one list rather than two.
  const allDrivers = await db
    .select()
    .from(drivers)
    .orderBy(asc(drivers.createdAt), asc(drivers.id));
  const driverNames = new Set(allDrivers.map((d) => d.name));

  if (addFleet) {
    const missing = EXTRA_DRIVERS.filter((d) => !driverNames.has(d.name));
    const withCars = missing.filter((d) => vehicleByLabel.has(d.vehicle));
    for (const d of missing) {
      if (!vehicleByLabel.has(d.vehicle)) {
        console.warn(`Skipping ${d.name}: no vehicle called "${d.vehicle}" in this database.`);
      }
    }
    if (withCars.length) {
      const startAt = allDrivers.length;
      const added = await db
        .insert(drivers)
        .values(
          withCars.map((d, n) => ({
            name: d.name,
            phone: `+1 917 555 ${String(2000 + startAt + n).slice(-4)}`,
            email: `${d.name.split(" ")[0].toLowerCase()}@ourcompany.example`,
            defaultVehicleId: vehicleByLabel.get(d.vehicle)!.id,
            licenceNumber: `5${String(100000 + (startAt + n) * 137).slice(-6)}`,
            active: true,
          }))
        )
        .returning();
      allDrivers.push(...added);
      summary.driversAdded = added.length;
    }
  }

  // --- Partners -----------------------------------------------------------
  if (addPartners) {
    const known = new Set(
      (await db.select({ company: affiliates.company }).from(affiliates)).map((a) => a.company)
    );
    const missing = EXTRA_AFFILIATES.filter((a) => !known.has(a.company));
    if (missing.length) {
      const added = await db
        .insert(affiliates)
        .values(
          missing.map((a) => ({
            ...a,
            coverageStates: [...a.coverageStates],
            coverageCities: [...a.coverageCities],
          }))
        )
        .returning();
      const cards = added.flatMap(rateCardFor);
      await db.insert(affiliateZones).values(cards);
      summary.affiliatesAdded = added.length;
      summary.rateBandsAdded = cards.length;
    }
  }

  // --- The rota -----------------------------------------------------------
  const now = DateTime.now().setZone(OPERATING_TIME_ZONE);
  const from = now.startOf("day");
  summary.rosteredThrough = from.plus({ days }).toFormat("cccc d LLLL yyyy");

  const active = allDrivers.filter((d) => d.active && d.defaultVehicleId);
  for (const d of allDrivers.filter((d) => d.active && !d.defaultVehicleId)) {
    console.warn(`Skipping ${d.name}: no vehicle, so a shift would be unbookable anyway.`);
  }
  if (active.length === 0) {
    console.warn("No active drivers, so there is nothing to roster.");
    return summary;
  }

  // Everything already on the books, in two parts: the history each driver's
  // pattern is read from, and the days already covered, which are left exactly
  // as they are. Somebody's booked leave in three weeks survives this.
  const allShifts = await db
    .select({ driverId: driverShifts.driverId, startsAt: driverShifts.startsAt })
    .from(driverShifts)
    .where(inArray(driverShifts.driverId, active.map((d) => d.id)));

  const history = new Map<string, DateTime[]>();
  const covered = new Set<string>();
  for (const shift of allShifts) {
    const at = DateTime.fromJSDate(shift.startsAt).setZone(OPERATING_TIME_ZONE);
    const seen = history.get(shift.driverId);
    if (seen) seen.push(at);
    else history.set(shift.driverId, [at]);
    covered.add(`${shift.driverId}:${at.toISODate()}`);
  }

  const classOf = new Map(existingVehicles.concat(
    [...vehicleByLabel.values()].filter((v) => !existingVehicles.some((e) => e.id === v.id))
  ).map((v) => [v.id, v.class]));
  const patterns = patternsFor(active, history, classOf);

  const rows: (typeof driverShifts.$inferInsert)[] = [];
  for (const driver of active) {
    const { homeHour, rest } = patterns.get(driver.id)!;

    for (let day = 0; day <= days; day++) {
      const date = from.plus({ days: day });
      if (date.weekday === rest[0] || date.weekday === rest[1]) continue;
      if (covered.has(`${driver.id}:${date.toISODate()}`)) continue;

      // No drift, and never unavailable, unlike the seed. Drift would make two
      // runs of this disagree about the same future day, and an absence three
      // months out is not something anybody knows about yet — inventing one
      // takes a car off the road for no reason a dispatcher could explain.
      const start = date.set({ hour: homeHour, minute: 0 });
      rows.push({
        driverId: driver.id,
        vehicleId: driver.defaultVehicleId,
        startsAt: start.toJSDate(),
        endsAt: start.plus({ hours: SHIFT_HOURS }).toJSDate(),
        unavailable: false,
        reason: null,
      });
    }
  }

  // In batches: a single insert of twenty thousand rows exceeds the parameter
  // limit and fails with a message about the roster having nothing to do with it.
  for (let i = 0; i < rows.length; i += 500) {
    await db.insert(driverShifts).values(rows.slice(i, i + 500));
  }
  summary.shiftsAdded = rows.length;

  return summary;
}

// Run directly: npm run roster:extend -- --days 120
if (process.argv[1]?.includes("extend-roster")) {
  const flag = process.argv.indexOf("--days");
  const days = flag >= 0 ? Number(process.argv[flag + 1]) : undefined;
  if (days !== undefined && (!Number.isFinite(days) || days < 1)) {
    console.error("--days needs a whole number of days, e.g. --days 90");
    process.exit(1);
  }

  extendRoster({
    days,
    fleet: !process.argv.includes("--no-fleet"),
    partners: !process.argv.includes("--no-partners"),
  })
    .then((summary) => {
      console.log("Roster extended:", summary);
      process.exit(0);
    })
    .catch((err) => {
      console.error("Extending the roster failed:", err);
      process.exit(1);
    });
}

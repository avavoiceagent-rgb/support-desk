// Dummy operational data: who drives, when, where they went, and what it cost.
//
// This is fabricated data for a real system, which is a combination worth being
// careful about. Two rules follow from it:
//
//  1. It is deterministic. The same seed produces the same drivers, shifts and
//     trips every time, so a bug found on Tuesday can be reproduced on Friday.
//  2. It only ever touches the operational tables. Tickets, messages and drafts
//     are real work and are never read or written here.
//
// Run with:  npm run seed:ops -- --reset
//
// Everything is hourly ("as directed"), which is how this company charges.

import { sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { db } from "./client";
import {
  affiliateZones,
  affiliates,
  driverShifts,
  drivers,
  invoiceLines,
  invoices,
  trips,
  vehicles,
} from "./schema";
import { OPERATING_TIME_ZONE } from "../booking/pickup-time";

/** Deterministic pseudo-randomness: same seed, same fleet, every run. */
function makeRandom(seed: number) {
  let state = seed >>> 0;
  return {
    next(): number {
      // Mulberry32 — small, fast, good enough for fixtures.
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    int(minInclusive: number, maxInclusive: number): number {
      return minInclusive + Math.floor(this.next() * (maxInclusive - minInclusive + 1));
    },
    pick<T>(items: readonly T[]): T {
      return items[Math.floor(this.next() * items.length)];
    },
    chance(probability: number): boolean {
      return this.next() < probability;
    },
  };
}

const HOURLY_RATE_CENTS = {
  SEDAN: 9_500,
  SUV: 12_500,
  VAN: 15_000,
  SPRINTER: 19_500,
} as const;

/** Hours are billed in tenths; the minimum charge is two hours for every class. */
export const MINIMUM_HOURS = 2;

/** What an invoice comes to, given a class and the hours actually worked. */
export function chargeCents(vehicleClass: keyof typeof HOURLY_RATE_CENTS, hours: number) {
  const billableHours = Math.max(hours, MINIMUM_HOURS);
  return {
    quantityTenths: Math.round(billableHours * 10),
    unitPriceCents: HOURLY_RATE_CENTS[vehicleClass],
    amountCents: Math.round(billableHours * HOURLY_RATE_CENTS[vehicleClass]),
  };
}

const VEHICLES = [
  { label: "Sedan 1", class: "SEDAN", makeModel: "Cadillac XTS", plate: "T512345C", passengerCapacity: 3, luggageCapacity: 3 },
  { label: "Sedan 2", class: "SEDAN", makeModel: "Lincoln Continental", plate: "T512346C", passengerCapacity: 3, luggageCapacity: 3 },
  { label: "Sedan 3", class: "SEDAN", makeModel: "Mercedes E-Class", plate: "T512347C", passengerCapacity: 3, luggageCapacity: 3 },
  { label: "Sedan 4", class: "SEDAN", makeModel: "BMW 5 Series", plate: "T512348C", passengerCapacity: 3, luggageCapacity: 3 },
  { label: "SUV 1", class: "SUV", makeModel: "Chevrolet Suburban", plate: "T512349C", passengerCapacity: 6, luggageCapacity: 6 },
  { label: "SUV 2", class: "SUV", makeModel: "Cadillac Escalade", plate: "T512350C", passengerCapacity: 6, luggageCapacity: 6 },
  { label: "SUV 3", class: "SUV", makeModel: "Chevrolet Suburban", plate: "T512351C", passengerCapacity: 6, luggageCapacity: 6 },
  { label: "SUV 4", class: "SUV", makeModel: "Lincoln Navigator", plate: "T512352C", passengerCapacity: 6, luggageCapacity: 6 },
  { label: "SUV 5", class: "SUV", makeModel: "Cadillac Escalade", plate: "T512355C", passengerCapacity: 6, luggageCapacity: 6 },
  { label: "SUV 6", class: "SUV", makeModel: "Chevrolet Suburban", plate: "T512356C", passengerCapacity: 6, luggageCapacity: 6 },
  { label: "Van 1", class: "VAN", makeModel: "Mercedes Metris", plate: "T512353C", passengerCapacity: 7, luggageCapacity: 7 },
  { label: "Van 2", class: "VAN", makeModel: "Mercedes Metris", plate: "T512357C", passengerCapacity: 7, luggageCapacity: 7 },
  { label: "Sprinter 1", class: "SPRINTER", makeModel: "Mercedes Sprinter", plate: "T512354C", passengerCapacity: 14, luggageCapacity: 14 },
  { label: "Sprinter 2", class: "SPRINTER", makeModel: "Mercedes Sprinter", plate: "T512358C", passengerCapacity: 14, luggageCapacity: 14 },
] as const;

// Sized against the work, not picked round. An eleven-hour shift covers under
// half the clock, so one driver of a class is on for roughly a third of the
// week once rest days are taken out — which is why a fleet with a single van
// ended up farming out every van booking it ever took. Each class needs enough
// people to be reachable at whatever hour the phone rings, not merely enough
// to do the volume.
const DRIVER_NAMES = [
  "Marco Rinaldi", "Dimitri Petrov", "Samuel Okafor", "Hector Alvarez",
  "Amrit Singh", "Joseph Nowak", "Kwame Boateng", "Luis Fernandes",
  "Ibrahim Diallo", "Peter Nowicki", "Rashid Karim", "Tomasz Wójcik",
  "Yusuf Demir", "Andrei Popescu", "Mateo Castillo", "Sanjay Iyer",
] as const;

const AFFILIATES = [
  // Nearby states — the drives that leave NY/NJ but stay regional.
  { company: "Liberty Bell Executive", baseAddress: "Philadelphia, PA", baseLat: 39.9526, baseLng: -75.1652, contactName: "Dana Whitfield", phone: "+1 215 555 0142", email: "dispatch@libertybellexec.example", coverageStates: ["PA", "DE"], coverageCities: ["Philadelphia", "Wilmington"], overflowPartner: false, hourlyRateUsd: 85, preference: 1, notes: "Reliable on Philadelphia airport runs. Invoices monthly." },
  { company: "Charter Oak Livery", baseAddress: "Hartford, CT", baseLat: 41.7658, baseLng: -72.6734, contactName: "Bill Marchetti", phone: "+1 860 555 0119", email: "ops@charteroaklivery.example", coverageStates: ["CT", "RI"], coverageCities: ["Hartford", "Stamford", "New Haven"], overflowPartner: false, hourlyRateUsd: 80, preference: 2, notes: "Good for Connecticut corporate work." },
  { company: "Hudson Valley Cars", baseAddress: "Poughkeepsie, NY", baseLat: 41.7004, baseLng: -73.921, contactName: "Erin Doyle", phone: "+1 845 555 0177", email: "bookings@hudsonvalleycars.example", coverageStates: ["NY"], coverageCities: ["Poughkeepsie", "Albany", "Newburgh"], overflowPartner: false, hourlyRateUsd: 75, preference: 2, notes: "Upstate only — will not come below Westchester." },
  // Major US cities.
  { company: "Beacon Hill Chauffeurs", baseAddress: "Boston, MA", baseLat: 42.3601, baseLng: -71.0589, contactName: "Maureen Kelly", phone: "+1 617 555 0163", email: "dispatch@beaconhillchauffeurs.example", coverageStates: ["MA"], coverageCities: ["Boston", "Cambridge"], overflowPartner: false, hourlyRateUsd: 95, preference: 1, notes: "Boston. Strong on Logan meet-and-greet." },
  { company: "Capital Executive Transport", baseAddress: "Washington, DC", baseLat: 38.9072, baseLng: -77.0369, contactName: "Gregory Sims", phone: "+1 202 555 0188", email: "ops@capitalexectransport.example", coverageStates: ["DC", "VA", "MD"], coverageCities: ["Washington", "Arlington", "Bethesda"], overflowPartner: false, hourlyRateUsd: 100, preference: 1, notes: "DC and both airports. Security-cleared drivers available." },
  { company: "Biscayne Luxury Rides", baseAddress: "Miami, FL", baseLat: 25.7617, baseLng: -80.1918, contactName: "Carla Mendes", phone: "+1 305 555 0155", email: "reservations@biscayneluxury.example", coverageStates: ["FL"], coverageCities: ["Miami", "Fort Lauderdale"], overflowPartner: false, hourlyRateUsd: 90, preference: 3, notes: "Miami. Slow to confirm in high season." },
  { company: "Windy City Executive", baseAddress: "Chicago, IL", baseLat: 41.8781, baseLng: -87.6298, contactName: "Ray Kowalski", phone: "+1 312 555 0134", email: "dispatch@windycityexec.example", coverageStates: ["IL"], coverageCities: ["Chicago", "Evanston"], overflowPartner: false, hourlyRateUsd: 85, preference: 2, notes: "Chicago, both airports." },
  { company: "Pacific Coast Livery", baseAddress: "Los Angeles, CA", baseLat: 34.0522, baseLng: -118.2437, contactName: "Sandra Nguyen", phone: "+1 310 555 0126", email: "ops@pacificcoastlivery.example", coverageStates: ["CA"], coverageCities: ["Los Angeles", "Santa Monica", "Beverly Hills"], overflowPartner: false, hourlyRateUsd: 105, preference: 2, notes: "LA. Three hours' notice minimum." },
  // Overflow partners — local, for when every one of our own cars is out.
  { company: "Metro Overflow Group", baseAddress: "New York, NY", baseLat: 40.7128, baseLng: -74.006, contactName: "Tony Barresi", phone: "+1 718 555 0198", email: "dispatch@metrooverflow.example", coverageStates: ["NY", "NJ"], coverageCities: ["New York", "Newark", "Jersey City"], overflowPartner: true, hourlyRateUsd: 70, preference: 1, notes: "First call when we are out of cars. Same-day usually fine." },
  { company: "Garden State Chauffeur", baseAddress: "Newark, NJ", baseLat: 40.7357, baseLng: -74.1724, contactName: "Priya Nair", phone: "+1 201 555 0171", email: "ops@gardenstatechauffeur.example", coverageStates: ["NJ", "NY"], coverageCities: ["Hoboken", "Newark", "Princeton"], overflowPartner: true, hourlyRateUsd: 72, preference: 2, notes: "Overflow, strongest in north Jersey." },
  { company: "Five Boroughs Car Service", baseAddress: "Queens, NY", baseLat: 40.7282, baseLng: -73.7949, contactName: "Ahmed Hassan", phone: "+1 917 555 0149", email: "bookings@fiveboroughs.example", coverageStates: ["NY"], coverageCities: ["New York", "Queens", "Brooklyn"], overflowPartner: true, hourlyRateUsd: 68, preference: 3, notes: "Overflow. Sedans only — no SUVs." },
] as const;

/**
 * Seeded places carry coordinates because real ones do.
 *
 * A trip created from an email keeps the point Google returned when the
 * address was geocoded, and the partner rate cards price by distance from
 * that point. Fixtures without coordinates would leave every seeded job
 * unpriceable and make a working feature look broken.
 *
 * These are approximate — good to a few hundred yards, which is far inside
 * any band boundary on a card. They are fixture data and are never shown to
 * a customer; nothing in the app takes a coordinate from this file.
 */
export const PICKUPS = [
  { address: "245 Park Avenue, New York, NY 10167", lat: 40.7548, lng: -73.9757, state: "NY" },
  { address: "40 Wall Street, New York, NY 10005", lat: 40.7069, lng: -74.009, state: "NY" },
  { address: "The Plaza Hotel, 768 5th Ave, New York, NY 10019", lat: 40.7644, lng: -73.9744, state: "NY" },
  { address: "1 Hotel Brooklyn Bridge, 60 Furman St, Brooklyn, NY 11201", lat: 40.7005, lng: -73.9962, state: "NY" },
  { address: "101 Hudson St, Jersey City, NJ 07302", lat: 40.7215, lng: -74.0347, state: "NJ" },
  { address: "The Ritz-Carlton, 50 Central Park S, New York, NY 10019", lat: 40.7658, lng: -73.9761, state: "NY" },
  { address: "200 West St, New York, NY 10282", lat: 40.7145, lng: -74.0145, state: "NY" },
  { address: "30 Hudson Yards, New York, NY 10001", lat: 40.7539, lng: -74.0013, state: "NY" },
] as const;

export const AIRPORTS = [
  { address: "JFK Terminal 4, Jamaica, NY 11430", lat: 40.6446, lng: -73.7822, state: "NY" },
  { address: "LaGuardia Airport Terminal B, East Elmhurst, NY 11371", lat: 40.7731, lng: -73.872, state: "NY" },
  { address: "Newark Liberty International Airport Terminal C, Newark, NJ 07114", lat: 40.6903, lng: -74.1775, state: "NJ" },
  { address: "Teterboro Airport, Teterboro, NJ 07608", lat: 40.8501, lng: -74.0608, state: "NJ" },
] as const;

/**
 * Destinations that genuinely leave the service area — every one in a state
 * other than NY or NJ.
 *
 * Mohonk Mountain House was in this list and should not have been: New Paltz
 * is in New York, so the app's own rule calls that trip INTERNAL while the
 * fixture labelled it "outside the service area". Fabricated data that
 * disagrees with the rules it is meant to demonstrate teaches a tester the
 * wrong thing about the system.
 */
export const OUT_OF_AREA = [
  { address: "Sheraton Philadelphia Downtown, 201 N 17th St, Philadelphia, PA 19103", state: "PA", lat: 39.956, lng: -75.167 },
  { address: "Boston Logan Airport Terminal B, Boston, MA 02128", state: "MA", lat: 42.3656, lng: -71.017 },
  { address: "The Willard InterContinental, 1401 Pennsylvania Ave NW, Washington, DC 20004", state: "DC", lat: 38.8963, lng: -77.0316 },
  { address: "Foxwoods Resort, 350 Trolley Line Blvd, Mashantucket, CT 06338", state: "CT", lat: 41.4746, lng: -71.96 },
  { address: "The Breakers, 44 Ochre Point Ave, Newport, RI 02840", state: "RI", lat: 41.4696, lng: -71.2985 },
  { address: "Hotel du Pont, 42 W 11th St, Wilmington, DE 19801", state: "DE", lat: 39.746, lng: -75.547 },
] as const;

/**
 * Work in a partner's own city, which is the only kind those three ever get.
 *
 * Miami, Chicago and Los Angeles are 1,100, 700 and 2,450 miles from here.
 * Nobody drives that: the customer flies and the partner in that city meets
 * them. So the job we hand over starts at their airport and ends at their
 * hotel, and their rate card is measured against a pickup a few miles from
 * their own base — which is what a rate card is for.
 *
 * The near partners are different and deliberately not listed here.
 * Philadelphia, Boston, Washington and Hartford are all inside the range a
 * single car covers in a day, so a New York pickup for them is ordinary
 * intercity work rather than a mistake.
 */
const AWAY_MARKETS = [
  {
    partner: "Biscayne Luxury Rides",
    from: { address: "Miami International Airport, Miami, FL 33142", lat: 25.7959, lng: -80.287, state: "FL" },
    to: { address: "The Setai, 2001 Collins Ave, Miami Beach, FL 33139", lat: 25.7987, lng: -80.1266, state: "FL" },
  },
  {
    partner: "Windy City Executive",
    from: { address: "O'Hare International Airport Terminal 5, Chicago, IL 60666", lat: 41.9786, lng: -87.9048, state: "IL" },
    to: { address: "The Langham, 330 N Wabash Ave, Chicago, IL 60611", lat: 41.8885, lng: -87.6285, state: "IL" },
  },
  {
    partner: "Pacific Coast Livery",
    from: { address: "Los Angeles International Airport, Los Angeles, CA 90045", lat: 33.9416, lng: -118.4085, state: "CA" },
    to: { address: "Beverly Wilshire, 9500 Wilshire Blvd, Beverly Hills, CA 90212", lat: 34.0669, lng: -118.4003, state: "CA" },
  },
] as const;

/** Every seeded place, for the backfill that fills older rows. */
export const AWAY_PLACES = AWAY_MARKETS.flatMap((m) => [m.from, m.to]);

const CUSTOMERS = [
  { name: "Daniel Weiss", email: "d.weiss@northbridgecapital.example", company: "Northbridge Capital" },
  { name: "Helen Brooks", email: "h.brooks@arlingtonpartners.example", company: "Arlington Partners" },
  { name: "Ana Costa", email: "a.costa@meridiangroup.example", company: "Meridian Group" },
  { name: "Priya Raman", email: "p.raman@stonegateadvisors.example", company: "Stonegate Advisors" },
  { name: "Tomás Oliveira", email: "t.oliveira@lisbonventures.example", company: "Lisbon Ventures" },
  { name: "Marcus Hale", email: "m.hale@haleandsons.example", company: "Hale & Sons" },
  { name: "Ruth Feldman", email: "r.feldman@feldmanlaw.example", company: "Feldman Law" },
  { name: "Kenji Watanabe", email: "k.watanabe@sakuraholdings.example", company: "Sakura Holdings" },
] as const;

export interface SeedSummary {
  vehicles: number;
  drivers: number;
  shifts: number;
  affiliates: number;
  rateBands: number;
  trips: number;
  invoices: number;
}

export async function seedOperations(options: { reset?: boolean; seed?: number } = {}): Promise<SeedSummary> {
  const rng = makeRandom(options.seed ?? 20260821);
  const now = DateTime.now().setZone(OPERATING_TIME_ZONE);
  const from = now.minus({ days: 30 }).startOf("day");
  const to = now.plus({ days: 14 }).endOf("day");

  // Refuse rather than half-insert. Without this, a second run collides on the
  // trip references and prints several screens of SQL, which tells the person
  // running it nothing about what to do next.
  const [existing] = await db.select({ n: sql<number>`count(*)::int` }).from(trips);
  if ((existing?.n ?? 0) > 0 && !options.reset) {
    throw new Error(
      `There are already ${existing.n} trips here. Pass --reset to replace the dummy data, ` +
        `or leave it alone if this database has anything real in it.`
    );
  }

  if (options.reset) {
    // Order matters: children first. Tickets and messages are never touched.
    await db.delete(invoiceLines);
    await db.delete(invoices);
    await db.delete(trips);
    await db.delete(driverShifts);
    await db.delete(drivers);
    await db.delete(affiliateZones);
    await db.delete(affiliates);
    await db.delete(vehicles);
  }

  const insertedVehicles = await db.insert(vehicles).values(VEHICLES.map((v) => ({ ...v }))).returning();
  const insertedAffiliates = await db.insert(affiliates).values(
    AFFILIATES.map((a) => ({ ...a, coverageStates: [...a.coverageStates], coverageCities: [...a.coverageCities] }))
  ).returning();

  // 12 drivers over 10 vehicles: the last two share, which is what makes the
  // schedule interesting — two people cannot take the same car at once.
  const insertedDrivers = await db.insert(drivers).values(
    DRIVER_NAMES.map((name, i) => ({
      name,
      phone: `+1 917 555 ${String(2000 + i).slice(-4)}`,
      email: `${name.split(" ")[0].toLowerCase()}@ourcompany.example`,
      defaultVehicleId: insertedVehicles[i % insertedVehicles.length].id,
      licenceNumber: `5${String(100000 + i * 137).slice(-6)}`,
      active: true,
    }))
  ).returning();

  // --- Partner rate cards --------------------------------------------------
  //
  // Built off the flat rate each partner already had, so the numbers stay
  // recognisable, then spread the way a real sheet is: dearer the further out
  // you go, and a longer minimum with it, because a car sent forty miles has
  // half a day gone whatever the job turns out to be.
  //
  // The multipliers are per class of car and are the same everywhere, which is
  // the one thing here that is tidier than life. Five Boroughs is the
  // exception the fixture needs: sedans only, so a quote for anything bigger
  // has to come back empty rather than guessed.
  const CLASS_MULTIPLIER = { SEDAN: 1, SUV: 1.35, VAN: 1.6, SPRINTER: 2.1 } as const;
  const BANDS = [
    { label: "Metro", fromMiles: 0, toMiles: 15, minimumHours: 2, uplift: 1 },
    { label: "Suburban", fromMiles: 15, toMiles: 40, minimumHours: 3, uplift: 1.12 },
    { label: "Regional", fromMiles: 40, toMiles: 100, minimumHours: 4, uplift: 1.25 },
    // Ends at 250 rather than running on for ever. A card with an open last
    // band answers "2,447 miles" with a confident price, which is how an LA
    // partner came to be quoted $1,200 for a Manhattan pickup. Real sheets
    // stop somewhere and say "call us" past it; here, past it the quote comes
    // back as a sentence instead of a number.
    { label: "Long haul", fromMiles: 100, toMiles: 250, minimumHours: 6, uplift: 1.4 },
  ] as const;

  const zoneRows: (typeof affiliateZones.$inferInsert)[] = [];
  for (const affiliate of insertedAffiliates) {
    const baseCents = (affiliate.hourlyRateUsd ?? 80) * 100;
    const sedanOnly = affiliate.company === "Five Boroughs Car Service";
    for (const band of BANDS) {
      const rateCents: Record<string, number> = {};
      for (const [vehicleClass, multiplier] of Object.entries(CLASS_MULTIPLIER)) {
        if (sedanOnly && vehicleClass !== "SEDAN") continue;
        // Rounded to the nearest five dollars: nobody quotes $103.87 an hour.
        const exact = baseCents * multiplier * band.uplift;
        rateCents[vehicleClass] = Math.round(exact / 500) * 500;
      }
      zoneRows.push({
        affiliateId: affiliate.id,
        label: band.label,
        fromMiles: band.fromMiles,
        toMiles: band.toMiles,
        minimumHours: band.minimumHours,
        rateCents,
        sortOrder: band.fromMiles,
      });
    }
  }
  await db.insert(affiliateZones).values(zoneRows);

  // --- Shifts -------------------------------------------------------------
  //
  // A rota, not a rubber stamp. The first version gave every driver the same
  // eleven-hour block on every single day of the month, which produced a fleet
  // where nobody ever rested and Amrit Singh worked 5pm-4am for thirty days
  // straight. Fabricated data that no real company could produce teaches a
  // tester nothing about the real thing.
  //
  // So: each driver keeps a home start hour, because people really are morning
  // or night people and a rota that reshuffles everyone daily is its own kind
  // of fiction. Around that, the start drifts by an hour and each driver takes
  // two rest days a week, staggered by index so the fleet is always covered.
  const SHIFT_HOURS = 11;

  /** The two weekdays this driver is off. Staggered so cover never collapses. */
  function restDays(driverIndex: number): [number, number] {
    return [(driverIndex % 7) + 1, ((driverIndex + 3) % 7) + 1];
  }

  interface Roster {
    driverIndex: number;
    startMs: number;
    endMs: number;
    unavailable: boolean;
  }
  const rosters: Roster[] = [];

  const shiftRows: (typeof driverShifts.$inferInsert)[] = [];
  for (let day = 0; from.plus({ days: day }) <= to; day++) {
    const date = from.plus({ days: day });
    for (const [i, driver] of insertedDrivers.entries()) {
      const [restA, restB] = restDays(i);
      if (date.weekday === restA || date.weekday === restB) continue;

      // Starts spaced two hours apart right around the clock. Eleven-hour
      // shifts every two hours means roughly five drivers are on at any moment,
      // including 3am, which is when airport work actually happens. The first
      // pass ran 5am to 7pm and left the ends of the day bare: a 9pm booking
      // had two drivers in the whole company who could take it, so a third of
      // the month farmed out for no reason a dispatcher would recognise.
      // Stepped by 5 rather than read straight off the index, and that detail
      // is the whole point. Drivers get their car by index too, so reading the
      // hours in order tied class to time of day: both van drivers landed on
      // night shifts and every afternoon van booking in the month farmed out
      // for want of a driver who was never rostered. 5 and 16 share no factor,
      // so each class ends up spread right around the clock.
      const HOURS = [4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 0, 2, 5, 9, 15, 21];
      const homeHour = HOURS[(i * 5) % HOURS.length];
      // A little drift, so the rota reads as written by a person.
      const startHour = (homeHour + rng.int(-1, 1) + 24) % 24;
      const start = date.set({ hour: startHour, minute: 0 });
      const end = start.plus({ hours: SHIFT_HOURS });
      const unavailable = rng.chance(0.05);

      shiftRows.push({
        driverId: driver.id,
        vehicleId: driver.defaultVehicleId,
        startsAt: start.toJSDate(),
        endsAt: end.toJSDate(),
        unavailable,
        reason: unavailable ? rng.pick(["Annual leave", "Sick", "Training", "Vehicle service"]) : null,
      });
      rosters.push({
        driverIndex: i,
        startMs: start.toMillis(),
        endMs: end.toMillis(),
        unavailable,
      });
    }
  }
  await db.insert(driverShifts).values(shiftRows);

  // --- Trips --------------------------------------------------------------
  /** Hours each driver is already committed to, so nobody is in two places at once. */
  const busy = new Map<string, [number, number][]>();

  const tripRows: (typeof trips.$inferInsert)[] = [];
  let reference = 10_000;

  for (let day = 0; from.plus({ days: day }) <= to; day++) {
    const date = from.plus({ days: day });
    const weekend = date.weekday >= 6;
    const tripsToday = weekend ? rng.int(2, 5) : rng.int(6, 11);
    const inPast = date < now.startOf("day");

    for (let n = 0; n < tripsToday; n++) {
      const customer = rng.pick(CUSTOMERS);
      // A job in a partner's own city, which they meet the customer for after
      // a flight. Always theirs, never one of ours.
      const away = rng.chance(0.05) ? rng.pick(AWAY_MARKETS) : null;
      const outOfArea = !away && rng.chance(0.12);
      // An away job is an airport pickup by definition.
      const airportRun = away ? true : !outOfArea && rng.chance(0.55);
      const pickupHour = rng.int(5, 21);
      const pickupAt = date.set({ hour: pickupHour, minute: rng.pick([0, 15, 30, 45]) });

      const destination = away
        ? away.to
        : outOfArea
          ? rng.pick(OUT_OF_AREA)
          : airportRun
            ? rng.pick(AIRPORTS)
            : rng.pick(PICKUPS);
      const origin = away ? away.from : rng.pick(PICKUPS);

      // The occasional roadshow or crew move. Without these the company owns
      // two Sprinters that never turn a wheel, and the largest vehicle class
      // never appears in a month of data anybody is meant to learn from.
      const bigGroup = rng.chance(0.05);
      const passengerCount = bigGroup ? rng.int(6, 12) : rng.int(1, 5);
      const vehicleClass = bigGroup
        ? "SPRINTER"
        : passengerCount > 3
          ? (rng.chance(0.15) ? "VAN" : "SUV")
          : "SEDAN";
      const bookedHours = outOfArea ? rng.int(4, 8) : airportRun ? rng.int(2, 3) : rng.int(3, 6);

      // Who could actually take this, and who is left over.
      //
      // The first version picked on vehicle class alone and never looked at the
      // rota, so trips landed on drivers who were off, on leave, or already out
      // on another job. That is worse than untidy: the desk refuses a
      // double-booking when a dispatcher tries to make one, so shipping fixture
      // data full of them means the training set contradicts the rules being
      // taught. A driver is a candidate only if a shift of theirs covers this
      // job end to end, they are not marked unavailable, and they are not
      // already out.
      const rank = { SEDAN: 1, SUV: 2, VAN: 3, SPRINTER: 4 } as const;
      const classOf = (d: (typeof insertedDrivers)[number]) =>
        insertedVehicles.find((veh) => veh.id === d.defaultVehicleId)?.class;

      const startMs = pickupAt.toMillis();
      const endMs = startMs + bookedHours * 3_600_000;

      const onDuty = (driverIndex: number) =>
        rosters.some(
          (r) =>
            r.driverIndex === driverIndex &&
            !r.unavailable &&
            r.startMs <= startMs &&
            r.endMs >= endMs
        );
      const alreadyOut = (driverId: string) =>
        (busy.get(driverId) ?? []).some(([s2, e2]) => s2 < endMs && e2 > startMs);

      const free = insertedDrivers.filter((d, i) => onDuty(i) && !alreadyOut(d.id));

      // A dispatcher sends the car that was booked. Occasionally the only thing
      // free is bigger, which is worth having in the data, but a Sprinter on a
      // sedan job should be the exception it is in real life, not one run in six.
      const exact = free.filter((d) => classOf(d) === vehicleClass);
      // Exactly one size up, never more. A dispatcher short of a sedan sends
      // the SUV; nobody sends a fourteen-seat Sprinter to collect one person
      // with a briefcase, and fixture data that does teaches the reader that
      // this desk cannot tell a car from a coach.
      const bigger = free.filter((d) => {
        const c = classOf(d);
        return c && rank[c] === rank[vehicleClass as keyof typeof rank] + 1;
      });
      const pool = exact.length && !rng.chance(0.08) ? exact : bigger;

      // Out of area always goes to a partner. Otherwise we farm out when — and
      // only when — nobody is actually free. "We ran out of cars" now happens
      // because the rota says so rather than on a 6% coin flip, which is the
      // whole point of having a rota in the fixture at all.
      const noVehicle = !outOfArea && !away && pool.length === 0;
      const farmedOut = outOfArea || Boolean(away) || noVehicle;
      let driver = pool.length ? rng.pick(pool) : null;

      // One deliberate exception, kept rare on purpose.
      //
      // Rosters change after work is assigned, and a trip left stranded outside
      // its driver's shift is a real dispatch problem — it is why the schedule
      // screen shows those in amber instead of tucking them into the nearest
      // shift. With a perfectly consistent fixture that warning would never
      // fire and nobody could tell whether it worked. So a few trips are left
      // stranded on purpose: never double-booked, just uncovered.
      if (!farmedOut && rng.chance(0.03)) {
        const stranded = insertedDrivers.filter(
          (d, i) => !onDuty(i) && !alreadyOut(d.id) && classOf(d) === vehicleClass
        );
        if (stranded.length) driver = rng.pick(stranded);
      }

      if (driver) {
        const windows = busy.get(driver.id) ?? [];
        windows.push([startMs, endMs]);
        busy.set(driver.id, windows);
      }

      // Who actually gets the work.
      //
      // This used to be any non-overflow partner at random, which is how a
      // Miami firm came to be holding a New York to Washington job. A partner
      // is chosen because they operate where the work is: for an away job
      // that is their own city, and for a trip leaving the state it is the
      // partner who covers the state it lands in.
      const covering = (state: string) =>
        insertedAffiliates.filter((a) => a.coverageStates.includes(state) && !a.overflowPartner);
      const overflow = insertedAffiliates.filter((a) => a.overflowPartner);
      const affiliate = away
        ? insertedAffiliates.find((a) => a.company === away.partner)!
        : outOfArea
          ? (covering(destination.state).length ? rng.pick(covering(destination.state)) : rng.pick(overflow))
          : rng.pick(overflow);

      const status = inPast
        ? rng.chance(0.04)
          ? rng.pick(["CANCELLED", "NO_SHOW"] as const)
          : "COMPLETED"
        : rng.chance(0.03)
          ? "CANCELLED"
          : "SCHEDULED";

      const actualHours =
        status === "COMPLETED" ? Math.max(MINIMUM_HOURS, bookedHours + (rng.chance(0.3) ? 1 : 0)) : null;

      tripRows.push({
        reference: `T-${reference++}`,
        passengerName: customer.name,
        passengerPhone: `+1 917 555 ${String(3000 + rng.int(0, 999)).slice(-4)}`,
        bookerName: customer.name,
        bookerEmail: customer.email,
        pickupAddress: origin.address,
        dropoffAddress: destination.address,
        pickupLat: origin.lat,
        pickupLng: origin.lng,
        pickupState: origin.state,
        dropoffLat: destination.lat,
        dropoffLng: destination.lng,
        dropoffState: destination.state,
        stops: rng.chance(0.15) ? ["40 Wall Street, New York, NY 10005"] : [],
        pickupAt: pickupAt.toJSDate(),
        bookedHours,
        actualHours,
        vehicleClass,
        passengerCount,
        luggageCount: rng.int(0, passengerCount + 1),
        flightNumber: airportRun ? `${rng.pick(["DL", "AA", "UA", "BA", "LH"])}${rng.int(100, 999)}` : null,
        status,
        assignedKind: farmedOut ? "AFFILIATE" : driver ? "DRIVER" : "UNASSIGNED",
        driverId: farmedOut ? null : (driver?.id ?? null),
        vehicleId: farmedOut ? null : (driver?.defaultVehicleId ?? null),
        affiliateId: farmedOut ? affiliate.id : null,
        farmOutReason: outOfArea || away ? "OUT_OF_AREA" : noVehicle ? "NO_VEHICLE" : null,
        notes: rng.chance(0.1) ? rng.pick(["Meet and greet requested", "Child seat required", "VIP — company director", "Quiet ride requested"]) : null,
      });
    }
  }
  const insertedTrips = await db.insert(trips).values(tripRows).returning();

  // --- Invoices -----------------------------------------------------------
  // Only completed trips are billed. One in twelve is disputed, which is what
  // gives the Accounting queue something real to answer.
  const completed = insertedTrips.filter((t) => t.status === "COMPLETED");
  let invoiceNumber = 10_000;
  const invoiceRows: (typeof invoices.$inferInsert)[] = [];
  const lineSeeds: { reference: string; trip: (typeof insertedTrips)[number]; charge: ReturnType<typeof chargeCents> }[] = [];

  for (const trip of completed) {
    const charge = chargeCents(trip.vehicleClass, trip.actualHours ?? trip.bookedHours);
    const issued = DateTime.fromJSDate(trip.pickupAt).setZone(OPERATING_TIME_ZONE).plus({ days: 1 });
    const disputed = rng.chance(1 / 12);
    const paid = !disputed && rng.chance(0.7);
    const ref = `INV-${invoiceNumber++}`;

    invoiceRows.push({
      reference: ref,
      tripId: trip.id,
      billToName: trip.bookerName ?? trip.passengerName,
      billToEmail: trip.bookerEmail ?? "accounts@unknown.example",
      issuedOn: issued.toJSDate(),
      dueOn: issued.plus({ days: 30 }).toJSDate(),
      status: disputed ? "DISPUTED" : paid ? "PAID" : "SENT",
      subtotalCents: charge.amountCents,
      totalCents: charge.amountCents,
      paidOn: paid ? issued.plus({ days: rng.int(3, 28) }).toJSDate() : null,
      disputeNote: disputed
        ? rng.pick([
            "Customer says the car waited 40 minutes but was billed a full extra hour.",
            "Booked 3 hours, billed 4 — customer asks why.",
            "Customer says this journey was cancelled and should not have been charged.",
            "Duplicate of an earlier invoice for the same date, per the customer.",
          ])
        : null,
    });
    lineSeeds.push({ reference: ref, trip, charge });
  }

  const insertedInvoices = await db.insert(invoices).values(invoiceRows).returning();
  const byReference = new Map(insertedInvoices.map((i) => [i.reference, i.id]));

  await db.insert(invoiceLines).values(
    lineSeeds.map(({ reference, trip, charge }) => ({
      invoiceId: byReference.get(reference)!,
      description: `${trip.vehicleClass} as directed — ${(charge.quantityTenths / 10).toFixed(1)} hours`,
      quantityTenths: charge.quantityTenths,
      unitPriceCents: charge.unitPriceCents,
      amountCents: charge.amountCents,
      sortOrder: 0,
    }))
  );

  return {
    vehicles: insertedVehicles.length,
    drivers: insertedDrivers.length,
    shifts: shiftRows.length,
    affiliates: insertedAffiliates.length,
    rateBands: zoneRows.length,
    trips: insertedTrips.length,
    invoices: insertedInvoices.length,
  };
}

// Run directly: npm run seed:ops -- --reset
if (process.argv[1]?.includes("seed-ops")) {
  const reset = process.argv.includes("--reset");
  seedOperations({ reset })
    .then((summary) => {
      console.log("Seeded operational data:", summary);
      process.exit(0);
    })
    .catch((err) => {
      console.error("Seeding failed:", err);
      process.exit(1);
    });
}

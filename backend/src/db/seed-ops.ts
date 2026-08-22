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
  { label: "Van 1", class: "VAN", makeModel: "Mercedes Metris", plate: "T512353C", passengerCapacity: 7, luggageCapacity: 7 },
  { label: "Sprinter 1", class: "SPRINTER", makeModel: "Mercedes Sprinter", plate: "T512354C", passengerCapacity: 14, luggageCapacity: 14 },
] as const;

const DRIVER_NAMES = [
  "Marco Rinaldi", "Dimitri Petrov", "Samuel Okafor", "Hector Alvarez",
  "Amrit Singh", "Joseph Nowak", "Kwame Boateng", "Luis Fernandes",
  "Ibrahim Diallo", "Peter Nowicki", "Rashid Karim", "Tomasz Wójcik",
] as const;

const AFFILIATES = [
  // Nearby states — the drives that leave NY/NJ but stay regional.
  { company: "Liberty Bell Executive", contactName: "Dana Whitfield", phone: "+1 215 555 0142", email: "dispatch@libertybellexec.example", coverageStates: ["PA", "DE"], coverageCities: ["Philadelphia", "Wilmington"], overflowPartner: false, hourlyRateUsd: 85, preference: 1, notes: "Reliable on Philadelphia airport runs. Invoices monthly." },
  { company: "Charter Oak Livery", contactName: "Bill Marchetti", phone: "+1 860 555 0119", email: "ops@charteroaklivery.example", coverageStates: ["CT", "RI"], coverageCities: ["Hartford", "Stamford", "New Haven"], overflowPartner: false, hourlyRateUsd: 80, preference: 2, notes: "Good for Connecticut corporate work." },
  { company: "Hudson Valley Cars", contactName: "Erin Doyle", phone: "+1 845 555 0177", email: "bookings@hudsonvalleycars.example", coverageStates: ["NY"], coverageCities: ["Poughkeepsie", "Albany", "Newburgh"], overflowPartner: false, hourlyRateUsd: 75, preference: 2, notes: "Upstate only — will not come below Westchester." },
  // Major US cities.
  { company: "Beacon Hill Chauffeurs", contactName: "Maureen Kelly", phone: "+1 617 555 0163", email: "dispatch@beaconhillchauffeurs.example", coverageStates: ["MA"], coverageCities: ["Boston", "Cambridge"], overflowPartner: false, hourlyRateUsd: 95, preference: 1, notes: "Boston. Strong on Logan meet-and-greet." },
  { company: "Capital Executive Transport", contactName: "Gregory Sims", phone: "+1 202 555 0188", email: "ops@capitalexectransport.example", coverageStates: ["DC", "VA", "MD"], coverageCities: ["Washington", "Arlington", "Bethesda"], overflowPartner: false, hourlyRateUsd: 100, preference: 1, notes: "DC and both airports. Security-cleared drivers available." },
  { company: "Biscayne Luxury Rides", contactName: "Carla Mendes", phone: "+1 305 555 0155", email: "reservations@biscayneluxury.example", coverageStates: ["FL"], coverageCities: ["Miami", "Fort Lauderdale"], overflowPartner: false, hourlyRateUsd: 90, preference: 3, notes: "Miami. Slow to confirm in high season." },
  { company: "Windy City Executive", contactName: "Ray Kowalski", phone: "+1 312 555 0134", email: "dispatch@windycityexec.example", coverageStates: ["IL"], coverageCities: ["Chicago", "Evanston"], overflowPartner: false, hourlyRateUsd: 85, preference: 2, notes: "Chicago, both airports." },
  { company: "Pacific Coast Livery", contactName: "Sandra Nguyen", phone: "+1 310 555 0126", email: "ops@pacificcoastlivery.example", coverageStates: ["CA"], coverageCities: ["Los Angeles", "Santa Monica", "Beverly Hills"], overflowPartner: false, hourlyRateUsd: 105, preference: 2, notes: "LA. Three hours' notice minimum." },
  // Overflow partners — local, for when every one of our own cars is out.
  { company: "Metro Overflow Group", contactName: "Tony Barresi", phone: "+1 718 555 0198", email: "dispatch@metrooverflow.example", coverageStates: ["NY", "NJ"], coverageCities: ["New York", "Newark", "Jersey City"], overflowPartner: true, hourlyRateUsd: 70, preference: 1, notes: "First call when we are out of cars. Same-day usually fine." },
  { company: "Garden State Chauffeur", contactName: "Priya Nair", phone: "+1 201 555 0171", email: "ops@gardenstatechauffeur.example", coverageStates: ["NJ", "NY"], coverageCities: ["Hoboken", "Newark", "Princeton"], overflowPartner: true, hourlyRateUsd: 72, preference: 2, notes: "Overflow, strongest in north Jersey." },
  { company: "Five Boroughs Car Service", contactName: "Ahmed Hassan", phone: "+1 917 555 0149", email: "bookings@fiveboroughs.example", coverageStates: ["NY"], coverageCities: ["New York", "Queens", "Brooklyn"], overflowPartner: true, hourlyRateUsd: 68, preference: 3, notes: "Overflow. Sedans only — no SUVs." },
] as const;

const PICKUPS = [
  "245 Park Avenue, New York, NY 10167",
  "40 Wall Street, New York, NY 10005",
  "The Plaza Hotel, 768 5th Ave, New York, NY 10019",
  "1 Hotel Brooklyn Bridge, 60 Furman St, Brooklyn, NY 11201",
  "101 Hudson St, Jersey City, NJ 07302",
  "The Ritz-Carlton, 50 Central Park S, New York, NY 10019",
  "200 West St, New York, NY 10282",
  "30 Hudson Yards, New York, NY 10001",
] as const;

const AIRPORTS = [
  "JFK Terminal 4, Jamaica, NY 11430",
  "LaGuardia Airport Terminal B, East Elmhurst, NY 11371",
  "Newark Liberty International Airport Terminal C, Newark, NJ 07114",
  "Teterboro Airport, Teterboro, NJ 07608",
] as const;

const OUT_OF_AREA = [
  { address: "Sheraton Philadelphia Downtown, 201 N 17th St, Philadelphia, PA 19103", state: "PA" },
  { address: "Boston Logan Airport Terminal B, Boston, MA 02128", state: "MA" },
  { address: "The Willard InterContinental, 1401 Pennsylvania Ave NW, Washington, DC 20004", state: "DC" },
  { address: "Foxwoods Resort, 350 Trolley Line Blvd, Mashantucket, CT 06338", state: "CT" },
  { address: "Mohonk Mountain House, 1000 Mountain Rest Rd, New Paltz, NY 12561", state: "NY" },
] as const;

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

  // --- Shifts -------------------------------------------------------------
  const shiftRows: (typeof driverShifts.$inferInsert)[] = [];
  for (let day = 0; from.plus({ days: day }) <= to; day++) {
    const date = from.plus({ days: day });
    const weekend = date.weekday >= 6;
    for (const [i, driver] of insertedDrivers.entries()) {
      // Staggered starts, not two blocks. A clean day/night changeover at 16:00
      // looked tidy and was wrong: a 3pm booking for 3 hours had nobody whose
      // shift covered it end to end, because the day crew clocked off in the
      // middle of it. Real rotas overlap, so these do.
      if (weekend && rng.chance(0.45)) continue;
      const startHour = [5, 6, 7, 9, 11, 13, 14, 15, 16, 17, 18, 19][i % 12];
      const start = date.set({ hour: startHour, minute: 0 });
      const unavailable = rng.chance(0.05);
      shiftRows.push({
        driverId: driver.id,
        vehicleId: driver.defaultVehicleId,
        startsAt: start.toJSDate(),
        endsAt: start.plus({ hours: 11 }).toJSDate(),
        unavailable,
        reason: unavailable ? rng.pick(["Annual leave", "Sick", "Training", "Vehicle service"]) : null,
      });
    }
  }
  await db.insert(driverShifts).values(shiftRows);

  // --- Trips --------------------------------------------------------------
  const tripRows: (typeof trips.$inferInsert)[] = [];
  let reference = 10_000;

  for (let day = 0; from.plus({ days: day }) <= to; day++) {
    const date = from.plus({ days: day });
    const weekend = date.weekday >= 6;
    const tripsToday = weekend ? rng.int(2, 5) : rng.int(6, 11);
    const inPast = date < now.startOf("day");

    for (let n = 0; n < tripsToday; n++) {
      const customer = rng.pick(CUSTOMERS);
      const outOfArea = rng.chance(0.12);
      const airportRun = !outOfArea && rng.chance(0.55);
      const pickupHour = rng.int(5, 21);
      const pickupAt = date.set({ hour: pickupHour, minute: rng.pick([0, 15, 30, 45]) });

      const destination = outOfArea
        ? rng.pick(OUT_OF_AREA).address
        : airportRun
          ? rng.pick(AIRPORTS)
          : rng.pick(PICKUPS);

      const passengerCount = rng.int(1, 5);
      const vehicleClass = passengerCount > 3 ? (rng.chance(0.15) ? "VAN" : "SUV") : "SEDAN";
      const bookedHours = outOfArea ? rng.int(4, 8) : airportRun ? rng.int(2, 3) : rng.int(3, 6);

      // Farm-outs: everything out of area, plus the odd day we simply run out
      // of cars — the case Amar described that no email ever reveals.
      const noVehicle = !outOfArea && rng.chance(0.06);
      const farmedOut = outOfArea || noVehicle;

      // The car has to match the booking. Assigning each driver their default
      // vehicle regardless produced trips reading "SEDAN" while showing "SUV 4",
      // and fabricated data that contradicts itself teaches a tester that the
      // system is confused when it is only the fixture that is.
      const rank = { SEDAN: 1, SUV: 2, VAN: 3, SPRINTER: 4 } as const;
      const classOf = (d: (typeof insertedDrivers)[number]) =>
        insertedVehicles.find((veh) => veh.id === d.defaultVehicleId)?.class;
      const exact = insertedDrivers.filter((d) => classOf(d) === vehicleClass);
      // A dispatcher sends the car that was booked. Occasionally the only thing
      // free is bigger, which is worth having in the data, but a Sprinter on a
      // sedan job should be the exception it is in real life, not one run in six.
      const bigger = insertedDrivers.filter((d) => {
        const c = classOf(d);
        return c && rank[c] > rank[vehicleClass as keyof typeof rank];
      });
      const pool = exact.length && !rng.chance(0.08) ? exact : bigger.length ? bigger : insertedDrivers;
      const driver = rng.pick(pool);
      const affiliate = outOfArea
        ? rng.pick(insertedAffiliates.filter((a) => !a.overflowPartner))
        : rng.pick(insertedAffiliates.filter((a) => a.overflowPartner));

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
        pickupAddress: rng.pick(PICKUPS),
        dropoffAddress: destination,
        stops: rng.chance(0.15) ? ["40 Wall Street, New York, NY 10005"] : [],
        pickupAt: pickupAt.toJSDate(),
        bookedHours,
        actualHours,
        vehicleClass,
        passengerCount,
        luggageCount: rng.int(0, passengerCount + 1),
        flightNumber: airportRun ? `${rng.pick(["DL", "AA", "UA", "BA", "LH"])}${rng.int(100, 999)}` : null,
        status,
        assignedKind: farmedOut ? "AFFILIATE" : "DRIVER",
        driverId: farmedOut ? null : driver.id,
        vehicleId: farmedOut ? null : driver.defaultVehicleId,
        affiliateId: farmedOut ? affiliate.id : null,
        farmOutReason: outOfArea ? "OUT_OF_AREA" : noVehicle ? "NO_VEHICLE" : null,
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

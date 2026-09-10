/**
 * The fields Adam can accept from SantaCruz, and what each one is.
 *
 * This is our half of the contract and the only half that is knowable today.
 * SantaCruz's column names are not written down anywhere in this codebase on
 * purpose: they are not known yet, they will change, and a guess at them would
 * be an invented fact repeated on every booking. A person maps their columns
 * onto these names on the SantaCruz screen, and only these names.
 *
 * Anything not listed here cannot be mapped. That is deliberate — a mapping
 * pointing at a field nothing reads is a silent no-op, and the person who set
 * it up would have no way of telling.
 */

export type FieldKind = "text" | "integer" | "decimal" | "timestamp" | "money";

export interface TargetField {
  /** The name shown on the mapping screen and stored in `target_field`. */
  name: string;
  kind: FieldKind;
  /** Without these a booking is not a booking, and the row is refused. */
  required: boolean;
  /** Said out loud on the mapping screen, so nobody has to guess what it means. */
  describe: string;
}

export const TARGET_FIELDS: TargetField[] = [
  {
    name: "externalId",
    kind: "text",
    required: true,
    describe:
      "Their own unique id for the booking. Without it an import cannot tell a changed booking from a new one, so every run would create duplicates.",
  },
  {
    name: "reference",
    kind: "text",
    required: false,
    describe: "The booking number a person would quote on the phone, if it differs from the id.",
  },
  {
    name: "pickupAt",
    kind: "timestamp",
    required: true,
    describe:
      "When the car is needed. Read in the time zone set on the connection screen, because a reservation system usually sends wall-clock time with no zone attached.",
  },
  {
    name: "pickupAddress",
    kind: "text",
    required: true,
    describe: "Where the car goes to collect.",
  },
  {
    name: "dropoffAddress",
    kind: "text",
    required: false,
    describe: "Where the job ends. Blank is allowed — an hourly booking may not have one.",
  },
  { name: "passengerName", kind: "text", required: false, describe: "Who is travelling." },
  { name: "passengerPhone", kind: "text", required: false, describe: "Their phone number." },
  { name: "bookerName", kind: "text", required: false, describe: "Who made the booking, if not the passenger." },
  { name: "bookerEmail", kind: "text", required: false, describe: "The booker's email address, used to match a booking to an email ticket." },
  { name: "bookedHours", kind: "decimal", required: false, describe: "How long the car is booked for." },
  { name: "vehicleClass", kind: "text", required: false, describe: "The size of car, in their words. Not translated to ours — that is a separate decision." },
  { name: "passengerCount", kind: "integer", required: false, describe: "How many people." },
  { name: "luggageCount", kind: "integer", required: false, describe: "How many bags. Left blank when they do not say — never assumed to be nought." },
  { name: "flightNumber", kind: "text", required: false, describe: "The flight, when there is one." },
  { name: "status", kind: "text", required: false, describe: "Their status for the booking, in their words." },
  { name: "driverName", kind: "text", required: false, describe: "Who they have assigned, if anybody." },
  { name: "priceCents", kind: "money", required: false, describe: "What the customer is being charged. Read as a money amount and stored in whole cents." },
  { name: "notes", kind: "text", required: false, describe: "Any note on their booking." },
];

const BY_NAME = new Map(TARGET_FIELDS.map((f) => [f.name, f]));

export function targetField(name: string): TargetField | null {
  return BY_NAME.get(name) ?? null;
}

export function isTargetField(name: string): boolean {
  return BY_NAME.has(name);
}

export const REQUIRED_FIELDS = TARGET_FIELDS.filter((f) => f.required).map((f) => f.name);

// The email that tells a customer their car is booked.
//
// Written in TypeScript, not by a model, and that is the point. Every line is
// a fact already on the reservation: the reference, the time, the two
// addresses, the car. There is nothing here to reason about, so asking a model
// to write it would only introduce the possibility of it being wrong — and
// wrong in a confirmation is worse than wrong anywhere else, because the
// customer will act on it and turn up at the time it gives them.
//
// It is never sent by itself. Creating a reservation drops this into the reply
// box, where a person reads it and presses Send. That keeps the desk's one
// unbreakable rule: nothing reaches a customer that nobody looked at.

import { DateTime } from "luxon";
import { OPERATING_TIME_ZONE } from "./pickup-time";
import { serviceAreaFromStates } from "./maps";
import { SERVICE_AREA_STATES } from "../types";
import type { FieldChange } from "../ops/trip-events";
import { money } from "../ops/margin";

/** Only what the email says. Keeps this testable without a database. */
export interface ConfirmableTrip {
  reference: string;
  passengerName: string;
  passengerPhone: string | null;
  pickupAddress: string;
  dropoffAddress: string;
  stops: string[];
  pickupAt: Date;
  bookedHours: number;
  vehicleClass: string;
  passengerCount: number | null;
  luggageCount: number | null;
  flightNumber: string | null;
  flightAt: Date | null;
  flightKind: string | null;
  /** Set when the job is going to a partner: we must not promise our own car. */
  affiliateCompany?: string | null;
  /**
   * What the customer is charged, in whole cents, once it is settled.
   *
   * Null until it is. A farmed-out job has no price until a partner quotes
   * and the desk takes that quote, which is exactly why the first reply says
   * we are checking availability rather than naming a figure.
   */
  customerPriceCents?: number | null;
}

const CLASS_WORD: Record<string, string> = {
  SEDAN: "Sedan",
  SUV: "SUV",
  VAN: "Van",
  SPRINTER: "Sprinter",
};

const day = (at: Date) =>
  DateTime.fromJSDate(at).setZone(OPERATING_TIME_ZONE).toFormat("cccc d LLLL yyyy");
const clock = (at: Date) =>
  DateTime.fromJSDate(at).setZone(OPERATING_TIME_ZONE).toFormat("h:mm a");
const stamp = (at: Date) => `${day(at)} at ${clock(at)}`;

function escape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** The booking as a list the customer can check line by line. */
export function detailLines(trip: ConfirmableTrip): string[] {
  const lines = [
    `Reference: ${trip.reference}`,
    `Passenger: ${trip.passengerName}`,
    `Pickup: ${stamp(trip.pickupAt)}`,
    `From: ${trip.pickupAddress}`,
  ];
  for (const stop of trip.stops) lines.push(`Via: ${stop}`);
  lines.push(`To: ${trip.dropoffAddress}`);

  if (trip.flightAt) {
    const kind = trip.flightKind ? ` (${trip.flightKind.toLowerCase()})` : "";
    const number = trip.flightNumber ? `${trip.flightNumber}, ` : "";
    lines.push(`Flight: ${number}${stamp(trip.flightAt)}${kind}`);
  } else if (trip.flightNumber) {
    lines.push(`Flight: ${trip.flightNumber}`);
  }

  lines.push(`Vehicle: ${CLASS_WORD[trip.vehicleClass] ?? trip.vehicleClass}`);

  // Only when we were told. A blank count is not a zero, and "0 passengers"
  // on a confirmation reads as a mistake, because it is one.
  //
  // A real zero is written in words. "0 bags" is how a database talks; a
  // customer travelling with nothing reads "no bags" and knows we listened.
  const count = (n: number, one: string, many: string) =>
    n === 0 ? `no ${many}` : `${n} ${n === 1 ? one : many}`;

  const party: string[] = [];
  if (typeof trip.passengerCount === "number") {
    party.push(count(trip.passengerCount, "passenger", "passengers"));
  }
  if (typeof trip.luggageCount === "number") {
    party.push(count(trip.luggageCount, "bag", "bags"));
  }
  if (party.length) lines.push(`Party: ${party.join(", ")}`);

  lines.push(`Booked for: ${trip.bookedHours} ${trip.bookedHours === 1 ? "hour" : "hours"}`);
  // Only once it is settled. A price on a confirmation is the line a customer
  // reads hardest, and a placeholder there is worse than no line at all.
  if (typeof trip.customerPriceCents === "number" && trip.customerPriceCents > 0) {
    lines.push(`Price: ${money(trip.customerPriceCents)}`);
  }
  if (trip.passengerPhone) lines.push(`Contact on the day: ${trip.passengerPhone}`);

  return lines;
}

const list = (lines: string[]) =>
  `<ul>${lines.map((l) => `<li>${escape(l)}</li>`).join("")}</ul>`;

/**
 * The first name to open with.
 *
 * No title, for the reason the compose prompt gives: a name says nothing about
 * how somebody wishes to be addressed, and guessing wrong is worse than not
 * trying. Falls back to no name rather than to "Sir/Madam".
 */
function greeting(name: string): string {
  const first = name.trim().split(/\s+/)[0];
  return first ? `<p>Hi ${escape(first)},</p>` : "<p>Hello,</p>";
}

/**
 * The car itself. A partner-covered job must not be confirmed as ours — the
 * same rule the draft follows — because a customer told "your driver" and met
 * by another company's car has been misled by us.
 */
function whoIsDriving(trip: ConfirmableTrip): string {
  return trip.affiliateCompany
    ? "<p>This journey is being covered by one of our partner operators. We will send you the driver and vehicle details before the day.</p>"
    : "<p>We will send you your driver's name, phone number and vehicle details before the day.</p>";
}

const CHECK_IT =
  "<p>Please have a read through and let us know straight away if anything here is not right.</p>";

/** Everything the gate below needs, which is less than a whole trip. */
export interface CoverageCheck {
  reference: string;
  status: string;
  driverId: string | null;
  affiliateId: string | null;
  pickupState?: string | null;
  dropoffState?: string | null;
}

/**
 * Why this booking cannot be confirmed to a customer yet, or null.
 *
 * "Your booking is confirmed" is a promise that a car will turn up, and on
 * T-10319 it went out while the reservation panel two inches away was saying
 * **"Nobody assigned yet"** and **"They are not on the job until they
 * confirm."** Metro had quoted $800 and been offered the job; being asked and
 * saying yes are different things. Had they come back no, a customer would
 * have been holding a written confirmation, at $1,000, for a car that was
 * never booked.
 *
 * The gate is only over jobs that leave the service area, and the distinction
 * is who owns the car:
 *
 *  - **Ours.** A booking inside NY/NJ with nobody assigned yet is a booking
 *    dispatch will cover from our own fleet. Confirming it promises something
 *    we can actually deliver, and holding the email hostage to an assignment
 *    would stop the desk answering a customer for hours.
 *  - **Somebody else's.** Outside the area we have no car at all. Until a
 *    partner has accepted, there is nothing to promise and no one to promise
 *    it on behalf of.
 *
 * Deliberately reads `affiliateId` rather than "an offer was sent". An offer
 * is a question. The partner lands on the trip when they accept, through the
 * same `updateTrip` a driver goes through, and that is the fact worth trusting.
 */
export function whyNotConfirmable(trip: CoverageCheck): string | null {
  if (trip.status === "CANCELLED") {
    return `${trip.reference} is cancelled, so there is nothing to confirm.`;
  }
  if (trip.driverId || trip.affiliateId) return null;

  const area = serviceAreaFromStates(
    [trip.pickupState, trip.dropoffState],
    SERVICE_AREA_STATES
  );
  if (area !== "EXTERNAL") return null;

  return (
    `${trip.reference} leaves the service area, so it needs a partner — and none has accepted it yet. ` +
    `Asking a partner and being told yes are different things: until one confirms, there is no car to promise. ` +
    `Their answer comes back in Operations → Messages.`
  );
}

/** A brand-new reservation. */
export function confirmationEmail(trip: ConfirmableTrip): string {
  return [
    greeting(trip.passengerName),
    "<p>Your booking is confirmed. Here are the details:</p>",
    list(detailLines(trip)),
    CHECK_IT,
    whoIsDriving(trip),
    "<p>Thank you for booking with us.</p>",
  ].join("");
}

/**
 * A booking that has moved.
 *
 * The changes come from the trip's own history rather than being worked out
 * again here, so the email and the audit trail cannot disagree about what
 * happened. Fields that mean nothing to a customer — who is driving, what the
 * dispatcher wrote in the notes — are left out of the "what changed" list;
 * they are ours, not theirs.
 */
const CUSTOMER_FIELDS = new Set([
  "Pickup",
  "Hours booked",
  "Car",
  "Flight",
  "Flight number",
  "Contact",
  "Status",
]);

export function changesWorthTelling(changes: FieldChange[]): FieldChange[] {
  return changes.filter((c) => CUSTOMER_FIELDS.has(c.field));
}

export function changeConfirmationEmail(trip: ConfirmableTrip, changes: FieldChange[]): string {
  const told = changesWorthTelling(changes);
  const moved = told.map((c) => `${c.field}: ${c.from ?? "not set"} → ${c.to ?? "not set"}`);

  return [
    greeting(trip.passengerName),
    `<p>We have updated your booking ${escape(trip.reference)}.</p>`,
    moved.length ? "<p>What has changed:</p>" + list(moved) : "",
    "<p>The booking now reads:</p>",
    list(detailLines(trip)),
    CHECK_IT,
    "<p>Thank you.</p>",
  ]
    .filter(Boolean)
    .join("");
}

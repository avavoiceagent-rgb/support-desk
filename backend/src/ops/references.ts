// Picking trip and invoice references out of what a customer wrote.
//
// This is the layer the lookup module deliberately left alone. `lookup.ts`
// canonicalises something already believed to be a reference; this decides
// which numbers in a paragraph of prose are one at all. That is the riskier
// half, so it is pure, and it errs towards finding nothing.
//
// The rule throughout: a number on its own is never a reference. An email
// about a ride to Newark is full of five-digit numbers that mean something
// else — postcodes, flight numbers, phone fragments, dollar amounts. Only a
// number a person has labelled counts, and the label is what we match on.
//
// That rule is why a bare `#10432` is deliberately NOT a reference, though an
// earlier draft of this file read it as a trip. A hash says a number matters;
// it does not say whether it is a trip, an invoice, or one of our own ticket
// numbers, which staff write exactly that way ("Ticket #60"). Reading it as a
// trip is a collision scheduled for the day ticket numbers reach four digits.
// `booking #10432` still works — the word carries the meaning and the hash is
// only punctuation. There is a test asserting a bare `#10432` finds nothing;
// it is there to stop this coming back.

import { normaliseReference } from "./lookup";

export interface ExtractedReferences {
  /** Canonical "T-10432", de-duplicated, in the order they appear. */
  trips: string[];
  /** Canonical "INV-10432", de-duplicated, in the order they appear. */
  invoices: string[];
}

/**
 * Shortest run of digits we will treat as a reference.
 *
 * Three, not five: the seed happens to start at 10000, but nothing guarantees
 * a reference is five digits forever, and hard-coding the current width would
 * quietly stop working. Two would start matching "trip 22" out of a date.
 */
const MIN_DIGITS = 3;

/**
 * Words that mark the number after them as a booking or a bill.
 *
 * "ride" and "job" are staff words rather than customer words, but staff
 * forward emails into the desk and quote references the same way.
 */
const TRIP_WORDS = "booking|bookings|trip|reservation|ride|job";
const INVOICE_WORDS = "invoice|invoices|bill";

/** "no.", "number", "ref" — noise that sits between the word and the digits. */
const OPTIONAL_LABEL = String.raw`(?:(?:no|nos|number|ref|reference)\b\.?[\s:#-]*)?`;

const REFERENCE_PATTERN = new RegExp(
  [
    // "T-10432", "T10432", "t 10432"
    String.raw`\bt[-\s]?(?<tripPrefix>\d{${MIN_DIGITS},})\b`,
    // "booking 10432", "trip no. 10432", "reservation #10432"
    String.raw`\b(?:${TRIP_WORDS})\b[\s:#-]*${OPTIONAL_LABEL}(?<tripWord>\d{${MIN_DIGITS},})\b`,
    // "INV-10432", "inv10432"
    String.raw`\binv[-\s]?(?<invoicePrefix>\d{${MIN_DIGITS},})\b`,
    // "invoice 10432", "invoice no. 10432"
    String.raw`\b(?:${INVOICE_WORDS})\b[\s:#-]*${OPTIONAL_LABEL}(?<invoiceWord>\d{${MIN_DIGITS},})\b`,
  ].join("|"),
  "gi"
);

/**
 * Every reference in a subject and body, de-duplicated, in the order written.
 *
 * De-duplication is by canonical form, not by what was typed, so "invoice
 * 10432" and "INV-10432" in the same email are one invoice. The subject is
 * scanned first because that is where a reference usually is.
 */
export function extractReferences(subject: string, body: string): ExtractedReferences {
  const trips: string[] = [];
  const invoices: string[] = [];
  const seen = new Set<string>();

  const add = (list: string[], digits: string, prefix: "T" | "INV") => {
    const canonical = normaliseReference(digits, prefix);
    if (!canonical || seen.has(canonical)) return;
    seen.add(canonical);
    list.push(canonical);
  };

  for (const text of [subject ?? "", body ?? ""]) {
    // Fresh lastIndex per pass: the regex is global and module-level.
    REFERENCE_PATTERN.lastIndex = 0;
    for (const match of text.matchAll(REFERENCE_PATTERN)) {
      const g = match.groups ?? {};
      if (g.tripPrefix) add(trips, g.tripPrefix, "T");
      else if (g.tripWord) add(trips, g.tripWord, "T");
      else if (g.invoicePrefix) add(invoices, g.invoicePrefix, "INV");
      else if (g.invoiceWord) add(invoices, g.invoiceWord, "INV");
    }
  }

  return { trips, invoices };
}

// Turning what a partner charges us into what we charge the customer.
//
// Whole cents, integers, no floating point. Money in doubles is how a job
// quoted at $262.50 turns up on an invoice as $262.49999999999997, and that
// number then gets emailed to somebody.
//
// The margin is one percentage for every job and every partner. That is a
// business decision, not a technical one — Amar runs it that way — and it
// lives in an environment variable so it can change without a deploy.

import { env } from "../config/env";

/** A sane percentage, whatever the environment says. */
export function marginPercent(raw: number = env.PARTNER_MARGIN_PERCENT): number {
  // A negative margin means selling at a loss and a missing one parses to NaN.
  // Neither should quietly become a price on a customer's email.
  return Number.isFinite(raw) && raw >= 0 ? raw : 25;
}

/**
 * What to charge the customer for a job a partner quoted.
 *
 * Rounded up to the nearest whole cent: rounding a margin down gives the
 * money away, one cent at a time, in our own arithmetic.
 */
export function customerPriceCents(
  partnerCents: number,
  percent: number = marginPercent()
): number {
  if (!Number.isFinite(partnerCents) || partnerCents < 0) return 0;
  return Math.ceil(partnerCents * (1 + percent / 100));
}

/** "$262.50" — for a screen or an email, never for storage. */
export function money(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const whole = Math.floor(Math.abs(cents) / 100);
  const part = String(Math.abs(cents) % 100).padStart(2, "0");
  return `${sign}$${whole.toLocaleString("en-US")}.${part}`;
}

/**
 * "$210.00" typed by a person, as cents.
 *
 * Null for anything that is not a price. A partner's quote becomes what a
 * customer is charged, so "about two hundred" has to be refused rather than
 * guessed at.
 */
export function parseMoney(input: string): number | null {
  const cleaned = input.trim().replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  return Math.round(Number(cleaned) * 100);
}

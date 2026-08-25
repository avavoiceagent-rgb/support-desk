// Money, on the screen and coming off a keyboard.
//
// Whole cents everywhere, mirroring backend/src/ops/margin.ts. Nothing here
// works out a price: what the customer is charged comes back from the server,
// because one margin computed in one place cannot disagree with itself.

/** "$262.50". */
export function money(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const whole = Math.floor(Math.abs(cents) / 100);
  const part = String(Math.abs(cents) % 100).padStart(2, "0");
  return `${sign}$${whole.toLocaleString("en-US")}.${part}`;
}

/**
 * A price somebody typed, as cents. Null if it is not one.
 *
 * A partner's quote becomes what a customer is charged, so "about two
 * hundred" has to be refused rather than rounded into something plausible.
 */
export function parseMoney(input: string): number | null {
  const cleaned = input.trim().replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  return Math.round(Number(cleaned) * 100);
}


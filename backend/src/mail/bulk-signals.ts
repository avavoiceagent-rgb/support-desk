// What made us think an email was bulk mail.
//
// The check used to answer a single boolean, which is enough to file the
// ticket and useless afterwards. When Railway's product newsletter arrived
// carrying none of these headers and sat open for two days, the question was
// "what did it actually send us?" — and nothing had kept the answer.
//
// So the same six checks now name themselves. An empty list is a real result
// and the interesting one: it means nothing in the envelope said bulk, and
// whatever happened next was a judgement rather than a fact.

/** Reads one header by name, case-insensitively. */
export type HeaderLookup = (name: string) => string | null | undefined;

/** Values of Precedence that mark mail as sent to a list rather than a person. */
const BULK_PRECEDENCE = ["bulk", "list", "auto_reply", "junk"];

/**
 * Some header values are evidence in themselves and some are noise. A
 * Precedence of "bulk" is the whole point; a List-Unsubscribe is a long URL
 * that tells a reader nothing the header name did not.
 */
const MAX_VALUE_CHARS = 60;

function withValue(name: string, value: string): string {
  const tidy = value.trim().replace(/\s+/g, " ");
  return tidy.length > MAX_VALUE_CHARS ? name : `${name}: ${tidy}`;
}

/**
 * Local parts that mean "nobody reads replies to this".
 *
 * Matched as substrings of the local part with punctuation stripped, which
 * catches things like "noreply-apps-scripts-notifications@google.com" and
 * "do-not-reply@...".
 */
const NO_REPLY_LOCAL_PARTS = [
  "noreply",
  "donotreply",
  "notification", // also matches "notifications"
  "mailerdaemon",
  "postmaster",
  "bounce", // also matches "bounces"
];

/**
 * True for a sender nobody can reply to, which is a bulk signal on its own —
 * a real customer writes from an address that can take an answer.
 */
export function isNoReplySender(fromHeader: string | null | undefined): boolean {
  if (!fromHeader) return false;
  const angle = fromHeader.match(/<(.+?)>/);
  const address = (angle ? angle[1] : fromHeader).trim().toLowerCase();
  const localPart = address.split("@")[0] ?? "";
  const normalized = localPart.replace(/[^a-z0-9]/g, "");
  if (!normalized) return false;
  return NO_REPLY_LOCAL_PARTS.some((p) => normalized.includes(p));
}

/**
 * Every bulk marker this email carried, named, in the order they are checked.
 *
 * Named rather than counted: "Precedence: bulk" and "a no-reply sender" are
 * different kinds of evidence, and a person looking at a closed ticket
 * deserves to see which one closed it.
 */
export function bulkSignals(get: HeaderLookup): string[] {
  const found: string[] = [];

  const autoSubmitted = get("Auto-Submitted");
  // "no" is the value ordinary mail is allowed to set, so it is not a signal.
  if (autoSubmitted && autoSubmitted.toLowerCase() !== "no") {
    found.push(withValue("Auto-Submitted", autoSubmitted));
  }

  const precedence = get("Precedence");
  if (precedence && BULK_PRECEDENCE.includes(precedence.toLowerCase())) {
    found.push(withValue("Precedence", precedence));
  }

  if (get("X-Autoreply")) found.push("X-Autoreply");

  // RFC 2369 mailing-list headers. Newsletters very often set only these,
  // which is why checking Auto-Submitted and Precedence alone let every
  // newsletter through and turned each one into a permanent open ticket.
  if (get("List-Unsubscribe")) found.push("List-Unsubscribe");
  if (get("List-Id")) found.push("List-Id");
  if (get("List-Post")) found.push("List-Post");

  if (isNoReplySender(get("From"))) found.push("no-reply sender");

  return found;
}

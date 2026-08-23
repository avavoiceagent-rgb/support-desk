// Pulling the address out of a From header.
//
// `messages.fromAddress` is the raw header, which can be any of:
//
//     ana@customer.example
//     Ana Costa <ana@customer.example>
//     "Costa, Ana" <ana@customer.example>
//
// `tickets.requesterEmail` is the already-parsed version and is what should be
// used. This exists for the places that fall back to the raw header when it is
// missing, because storing `Ana Costa <ana@…>` in a column that is later
// matched with `lower(booker_email) = ?` means that customer's trips never
// appear in their own history again.

/** The bare address, or null if there is not one in there. */
export function emailFromHeader(header: string | null | undefined): string | null {
  if (!header) return null;

  // Angle brackets win: a display name can itself contain an @ sign, and
  // "billing@acme" <ana@customer.example> is from Ana, not from billing.
  const bracketed = header.match(/<([^<>]+)>/);
  const candidate = (bracketed ? bracketed[1] : header).trim().replace(/^"|"$/g, "");

  return looksLikeEmail(candidate) ? candidate : null;
}

/**
 * Good enough to store, not a validator.
 *
 * Deliberately loose: the job here is to reject a display name and a header we
 * failed to parse, not to adjudicate what RFC 5321 permits.
 */
export function looksLikeEmail(value: string): boolean {
  return /^[^\s<>@]+@[^\s<>@.]+(\.[^\s<>@.]+)+$/.test(value);
}

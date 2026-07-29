// Fallback thread resolution for providers/messages where the native
// thread id (Gmail threadId, Graph conversationId) doesn't line up with an
// existing ticket for some reason (e.g. a customer starts a fresh email
// quoting an old one, or a provider migration). Both Gmail and Graph have
// native threading, so this is defensive rather than the primary path —
// the primary path is always "match on (emailAccountId, providerThreadId)".

import type { NormalizedEmail } from "./provider.interface";

/**
 * Returns the Message-ID this email is most likely replying to, derived from
 * the References header (which accumulates the whole chain) or, failing
 * that, In-Reply-To directly.
 */
export function resolveParentMessageId(email: NormalizedEmail): string | undefined {
  if (email.referencesHeader) {
    const ids = email.referencesHeader.trim().split(/\s+/).filter(Boolean);
    if (ids.length > 0) return ids[ids.length - 1];
  }
  return email.inReplyToHeader?.trim();
}

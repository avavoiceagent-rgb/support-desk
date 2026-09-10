import { and, eq, gte, isNull } from "drizzle-orm";
import { db } from "../db/client";
import { emailAccounts, tickets } from "../db/schema";
import { env } from "../config/env";
import { decryptToken } from "../crypto/token-encryption";
import { getProvider } from "./registry";
import { ingestEmail, markAccountError, clearAccountError } from "./ingest";
import { classifyNewTicket } from "../services/classification.service";
import {
  draftReplyForTicket,
  draftChangeReplyForTicket,
  refreshFactsFromReply,
} from "../services/draft.service";

let timer: ReturnType<typeof setInterval> | null = null;
let polling = false;

export interface PollSummary {
  /** How many genuinely new emails were turned into tickets/messages. */
  newMessages: number;
  /** Mailboxes whose poll failed (their lastError is updated). */
  failedAccounts: number;
  /** True when a poll was already running, so this call did nothing. */
  skipped: boolean;
}

export async function pollAllAccounts(): Promise<PollSummary> {
  // Avoid overlapping runs if one poll takes longer than the interval.
  if (polling) return { newMessages: 0, failedAccounts: 0, skipped: true };
  polling = true;
  let newMessages = 0;
  let failedAccounts = 0;
  const newTicketIds: string[] = [];
  // Tickets that got a reply rather than a first email. Their stored booking
  // facts may now be out of date — see refreshFactsFromReply.
  const repliedTicketIds: string[] = [];
  try {
    let accounts;
    try {
      accounts = await db.select().from(emailAccounts);
    } catch (err) {
      // A transient DB outage must never crash the app — skip this poll.
      console.error("[mail-poller] could not load accounts, skipping poll:", err);
      return { newMessages: 0, failedAccounts: 0, skipped: true };
    }
    for (const account of accounts) {
      try {
        const provider = getProvider(account.provider);
        const refreshToken = decryptToken({
          ciphertext: account.encryptedRefreshToken,
          iv: account.tokenIv,
          authTag: account.tokenAuthTag,
        });

        const cursor = account.syncCursor ? { raw: account.syncCursor } : null;
        const { messages, nextCursor } = await provider.listNewMessages(refreshToken, cursor);

        for (const email of messages) {
          const { created, ticketId, newTicketId } = await ingestEmail(account.id, email);
          if (created) newMessages++;
          if (newTicketId) newTicketIds.push(newTicketId);
          else if (created && !repliedTicketIds.includes(ticketId)) repliedTicketIds.push(ticketId);
        }

        await db
          .update(emailAccounts)
          .set({ syncCursor: nextCursor.raw, updatedAt: new Date() })
          .where(eq(emailAccounts.id, account.id));

        if (account.status !== "connected") {
          await clearAccountError(account.id);
        }
      } catch (err) {
        failedAccounts++;
        console.error(`[mail-poller] account ${account.email} failed:`, err);
        await markAccountError(account.id, err instanceof Error ? err.message : String(err));
      }
    }
    return { newMessages, failedAccounts, skipped: false };
  } finally {
    polling = false;
    // Triage runs AFTER the mail is safely stored and, deliberately, after
    // the polling lock is released: the AI is the slowest thing here, and it
    // must not hold up the next poll or keep the "Check for new email"
    // request waiting. Each ticket is independent and failures are swallowed.
    void triageInBackground(newTicketIds);
    void catchUpOnReplies(repliedTicketIds);
    // And anything that was ingested but never sorted — see below. Runs on
    // every poll, not only when new mail arrived, because the poll that
    // dropped a ticket is by definition the one that is no longer running.
    void triageWhatWasMissed();
  }
}

/**
 * How far back to look for a ticket nobody sorted, and how many to take.
 *
 * Bounded on purpose. The window has to be comfortably longer than a deploy
 * or an outage at the model, and short enough that it cannot reach back and
 * overrule a person who deliberately left an older ticket in no queue at all —
 * which is a real thing the screen lets them do.
 */
const MISSED_TRIAGE_WINDOW_MS = 2 * 60 * 60 * 1000;
const MISSED_TRIAGE_LIMIT = 25;

/**
 * Sort the tickets that arrived and never got sorted.
 *
 * Triage used to run only for tickets the poll had just created, so anything
 * that interrupted it left that ticket stranded for good: no queue, no draft,
 * no note, nothing on the screen to say it had been missed. It looked exactly
 * like a ticket that arrived and was ignored, and nothing would ever pick it
 * up again.
 *
 * Found by deploying while a test email was in flight. The container was
 * replaced between storing the ticket and sorting it — which is not a rare
 * accident but the ordinary consequence of shipping during working hours,
 * and would have done the same to a real customer's email.
 *
 * `classifyNewTicket` already refuses to touch a ticket whose queue somebody
 * has set, so this can only ever fill a gap, never overwrite a decision.
 *
 * The selection is exported on its own so the rule can be tested without a
 * model: which tickets count as missed is the part worth getting right.
 */
export async function ticketsMissedByTriage(now: Date = new Date()): Promise<string[]> {
  const since = new Date(now.getTime() - MISSED_TRIAGE_WINDOW_MS);
  const rows = await db
    .select({ id: tickets.id })
    .from(tickets)
    .where(and(isNull(tickets.queue), eq(tickets.isBulk, false), gte(tickets.createdAt, since)))
    .limit(MISSED_TRIAGE_LIMIT);
  return rows.map((r) => r.id);
}

async function triageWhatWasMissed(): Promise<void> {
  try {
    const stranded = await ticketsMissedByTriage();
    if (stranded.length === 0) return;
    console.log(`[mail-poller] ${stranded.length} ticket(s) were never sorted; sorting them now`);
    await triageInBackground(stranded);
  } catch (err) {
    console.error("[mail-poller] catching up on missed triage failed:", err);
  }
}

async function triageInBackground(ticketIds: string[]): Promise<void> {
  for (const ticketId of ticketIds) {
    try {
      await classifyNewTicket(ticketId);
      // Both drafters check the ticket's own queue and type and decline the
      // ones that are not theirs, so classification has to have landed first.
      // Run in order rather than together: each refuses to write a second
      // draft over an existing one, and two racing would make which of them
      // wins a matter of timing.
      await draftReplyForTicket(ticketId);
      await draftChangeReplyForTicket(ticketId);
    } catch (err) {
      console.error(`[mail-poller] triage failed for ticket ${ticketId}:`, err);
    }
  }
}

/**
 * Keep a booking's facts current when the customer answers.
 *
 * Same shape as triage: after the mail is stored, after the lock is
 * released, one ticket at a time, failures swallowed. A reply that adds a
 * phone number should not be able to hold up the next poll.
 */
async function catchUpOnReplies(ticketIds: string[]): Promise<void> {
  for (const ticketId of ticketIds) {
    try {
      const changes = await refreshFactsFromReply(ticketId);
      if (changes.length) {
        console.log(`[mail-poller] ticket ${ticketId} reply updated: ${changes.join("; ")}`);
      }
    } catch (err) {
      console.error(`[mail-poller] could not re-read reply for ticket ${ticketId}:`, err);
    }
  }
}

export function startMailPoller(): void {
  if (timer) return;
  // Fire once shortly after boot, then on the configured interval.
  setTimeout(() => void pollAllAccounts(), 5000);
  timer = setInterval(() => void pollAllAccounts(), env.MAIL_POLL_INTERVAL_MS);
}

export function stopMailPoller(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

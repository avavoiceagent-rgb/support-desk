import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { emailAccounts } from "../db/schema";
import { env } from "../config/env";
import { decryptToken } from "../crypto/token-encryption";
import { getProvider } from "./registry";
import { ingestEmail, markAccountError, clearAccountError } from "./ingest";
import { classifyNewTicket } from "../services/classification.service";
import { draftReplyForTicket } from "../services/draft.service";

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
          const { created, newTicketId } = await ingestEmail(account.id, email);
          if (created) newMessages++;
          if (newTicketId) newTicketIds.push(newTicketId);
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
  }
}

async function triageInBackground(ticketIds: string[]): Promise<void> {
  for (const ticketId of ticketIds) {
    try {
      await classifyNewTicket(ticketId);
      // Drafting only applies to new reservations; the service checks that
      // itself, so classification has to have landed first.
      await draftReplyForTicket(ticketId);
    } catch (err) {
      console.error(`[mail-poller] triage failed for ticket ${ticketId}:`, err);
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

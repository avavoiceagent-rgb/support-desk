// Optional helper for local testing: seeds a demo mailbox + a couple of
// sample tickets WITHOUT touching a real mail provider, so you can exercise
// the UI (reply/notes/assign/status) before a real Gmail account is
// connected. Outbound "replies" made against seeded tickets will fail
// (there's no real provider behind them) — connect a real Gmail account via
// Settings to test actual sending.
import { db, pool } from "./client";
import { emailAccounts, tickets, messages } from "./schema";
import { encryptToken } from "../crypto/token-encryption";

async function main() {
  const fakeToken = encryptToken("seed-placeholder-not-a-real-token");
  const [account] = await db
    .insert(emailAccounts)
    .values({
      provider: "GMAIL",
      email: "demo-support@example.com",
      encryptedRefreshToken: fakeToken.ciphertext,
      tokenIv: fakeToken.iv,
      tokenAuthTag: fakeToken.authTag,
      status: "disconnected",
      lastError: "Demo account — connect a real Gmail account from Settings to send/receive mail.",
    })
    .returning();

  const [ticket1] = await db
    .insert(tickets)
    .values({
      subject: "Can't log into my account",
      requesterEmail: "alex@example.com",
      requesterName: "Alex Rivera",
      providerThreadId: "demo-thread-1",
      emailAccountId: account.id,
      status: "OPEN",
    })
    .returning();

  await db.insert(messages).values({
    ticketId: ticket1.id,
    direction: "INBOUND",
    fromAddress: "Alex Rivera <alex@example.com>",
    toAddresses: ["demo-support@example.com"],
    ccAddresses: [],
    subject: "Can't log into my account",
    bodyHtml: "<p>Hi, I've been trying to log in since yesterday and keep getting an error. Can you help?</p>",
    bodyText: "Hi, I've been trying to log in since yesterday and keep getting an error. Can you help?",
    providerMessageId: "demo-msg-1",
    providerThreadId: "demo-thread-1",
    sentAt: new Date(Date.now() - 1000 * 60 * 60 * 3),
  });

  const [ticket2] = await db
    .insert(tickets)
    .values({
      subject: "Refund request for order #4821",
      requesterEmail: "sam@example.com",
      requesterName: "Sam Lee",
      providerThreadId: "demo-thread-2",
      emailAccountId: account.id,
      status: "CLOSED",
    })
    .returning();

  await db.insert(messages).values({
    ticketId: ticket2.id,
    direction: "INBOUND",
    fromAddress: "Sam Lee <sam@example.com>",
    toAddresses: ["demo-support@example.com"],
    ccAddresses: [],
    subject: "Refund request for order #4821",
    bodyHtml: "<p>Please refund order #4821, it arrived damaged.</p>",
    bodyText: "Please refund order #4821, it arrived damaged.",
    providerMessageId: "demo-msg-2",
    providerThreadId: "demo-thread-2",
    sentAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 2),
  });

  console.log("Seeded demo mailbox and 2 sample tickets.");
  await pool.end();
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});

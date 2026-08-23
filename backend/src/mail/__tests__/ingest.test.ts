import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { db, pool } from "../../db/client";
import { emailAccounts, tickets, messages } from "../../db/schema";
import { eq } from "drizzle-orm";
import { ingestEmail } from "../ingest";
import type { NormalizedEmail } from "../provider.interface";

function makeEmail(overrides: Partial<NormalizedEmail> = {}): NormalizedEmail {
  return {
    providerMessageId: `msg-${Math.random().toString(36).slice(2)}`,
    providerThreadId: "thread-1",
    messageIdHeader: `<${Math.random().toString(36).slice(2)}@customer.example>`,
    from: "Jane Customer <jane@customer.example>",
    to: ["support@ourcompany.example"],
    cc: [],
    subject: "Help with my order",
    bodyText: "Hi, I have a question about my order.",
    bodyHtml: "<p>Hi, I have a question about my order.</p>",
    attachments: [],
    receivedAt: new Date(),
    isAutoReply: false,
    bulkSignals: [],
    ...overrides,
  };
}

let accountId: string;

beforeEach(async () => {
  await db.delete(messages);
  await db.delete(tickets);
  await db.delete(emailAccounts);
  const [account] = await db
    .insert(emailAccounts)
    .values({
      provider: "GMAIL",
      email: "support@ourcompany.example",
      encryptedRefreshToken: "x",
      tokenIv: "x",
      tokenAuthTag: "x",
    })
    .returning();
  accountId = account.id;
});

afterAll(async () => {
  await pool.end();
});

describe("ingestEmail", () => {
  it("creates a new ticket for a new thread", async () => {
    const { ticketId } = await ingestEmail(accountId, makeEmail());
    const [ticket] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
    expect(ticket).toBeTruthy();
    expect(ticket.status).toBe("OPEN");
    expect(ticket.requesterEmail).toBe("jane@customer.example");
    expect(ticket.requesterName).toBe("Jane Customer");
  });

  it("is idempotent: re-ingesting the same providerMessageId does not duplicate", async () => {
    const email = makeEmail();
    const first = await ingestEmail(accountId, email);
    const second = await ingestEmail(accountId, email);
    expect(second.ticketId).toBe(first.ticketId);

    const msgs = await db.select().from(messages).where(eq(messages.providerMessageId, email.providerMessageId));
    expect(msgs).toHaveLength(1);
  });

  it("groups a second message on the same providerThreadId into the same ticket", async () => {
    const first = await ingestEmail(accountId, makeEmail({ providerThreadId: "thread-2" }));
    const second = await ingestEmail(
      accountId,
      makeEmail({ providerThreadId: "thread-2", subject: "Re: Help with my order" })
    );
    expect(second.ticketId).toBe(first.ticketId);

    const msgs = await db.select().from(messages).where(eq(messages.ticketId, first.ticketId));
    expect(msgs).toHaveLength(2);
  });

  it("reopens a closed ticket when a genuine reply arrives on its thread", async () => {
    const { ticketId } = await ingestEmail(accountId, makeEmail({ providerThreadId: "thread-3" }));
    await db.update(tickets).set({ status: "RESOLVED_CLOSED" }).where(eq(tickets.id, ticketId));

    await ingestEmail(accountId, makeEmail({ providerThreadId: "thread-3", isAutoReply: false }));

    const [ticket] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
    expect(ticket.status).toBe("OPEN");
  });

  it("does NOT reopen a closed ticket for an auto-reply", async () => {
    const { ticketId } = await ingestEmail(accountId, makeEmail({ providerThreadId: "thread-4" }));
    await db.update(tickets).set({ status: "RESOLVED_CLOSED" }).where(eq(tickets.id, ticketId));

    await ingestEmail(
      accountId,
      makeEmail({ providerThreadId: "thread-4", isAutoReply: true, subject: "Out of office" })
    );

    const [ticket] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
    expect(ticket.status).toBe("RESOLVED_CLOSED");

    const msgs = await db.select().from(messages).where(eq(messages.ticketId, ticketId));
    expect(msgs).toHaveLength(2); // the auto-reply is still logged, just doesn't reopen
  });

  it("creates newsletters as closed, bulk-flagged tickets", async () => {
    const { ticketId } = await ingestEmail(
      accountId,
      makeEmail({ providerThreadId: "thread-news", subject: "Our August newsletter", isAutoReply: true })
    );
    const [ticket] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
    expect(ticket.isBulk).toBe(true);
    expect(ticket.status).toBe("UNRESOLVED_CLOSED");
  });

  it("keeps the markers that made it bulk, on the message", async () => {
    // The verdict lives on the ticket and the evidence lives here, so
    // "why was this closed?" has an answer after the fact.
    const { ticketId } = await ingestEmail(
      accountId,
      makeEmail({
        providerThreadId: "thread-evidence",
        isAutoReply: true,
        bulkSignals: ["Precedence: bulk", "List-Unsubscribe"],
      })
    );
    const [msg] = await db.select().from(messages).where(eq(messages.ticketId, ticketId));
    expect(msg.bulkSignals).toEqual(["Precedence: bulk", "List-Unsubscribe"]);
  });

  it("stores an empty list for ordinary mail rather than null", async () => {
    // Empty means "we looked and the envelope said nothing", which is a
    // different claim from "we never looked". Older rows say the latter.
    const { ticketId } = await ingestEmail(accountId, makeEmail({ providerThreadId: "thread-plain" }));
    const [msg] = await db.select().from(messages).where(eq(messages.ticketId, ticketId));
    expect(msg.bulkSignals).toEqual([]);
  });

  it("clears the bulk flag when a real person writes in on that thread", async () => {
    const { ticketId } = await ingestEmail(
      accountId,
      makeEmail({ providerThreadId: "thread-mixed", isAutoReply: true })
    );
    await ingestEmail(accountId, makeEmail({ providerThreadId: "thread-mixed", isAutoReply: false }));
    const [ticket] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
    expect(ticket.isBulk).toBe(false);
    expect(ticket.status).toBe("OPEN");
  });

  it("keeps ordinary customer mail out of the bulk bucket", async () => {
    const { ticketId } = await ingestEmail(accountId, makeEmail({ providerThreadId: "thread-real" }));
    const [ticket] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
    expect(ticket.isBulk).toBe(false);
    expect(ticket.status).toBe("OPEN");
  });

  it("reports created=true only the first time a message is seen", async () => {
    const email = makeEmail({ providerThreadId: "thread-count" });
    const first = await ingestEmail(accountId, email);
    const second = await ingestEmail(accountId, email);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.ticketId).toBe(first.ticketId);
  });

  it("sanitizes inbound HTML to strip scripts", async () => {
    const { ticketId } = await ingestEmail(
      accountId,
      makeEmail({
        providerThreadId: "thread-5",
        bodyHtml: '<p>Hello</p><script>alert("xss")</script>',
      })
    );
    const [msg] = await db.select().from(messages).where(eq(messages.ticketId, ticketId));
    expect(msg.bodyHtml).not.toContain("<script>");
    expect(msg.bodyHtml).toContain("Hello");
  });
});

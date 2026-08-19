import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool } from "../../db/client";
import { emailAccounts, tickets, messages } from "../../db/schema";
// vi.mock below is hoisted above this import by vitest, so the mocked
// classifier is what classification.service sees.
import { classifyNewTicket } from "../classification.service";

// The AI call itself is mocked: these tests are about what we do with an
// answer, not about the model. Network behaviour is verified against the real
// API in production.
const classifyEmail = vi.hoisted(() => vi.fn());
vi.mock("../../ai/classifier", () => ({
  classifyEmail,
  isClassificationEnabled: () => true,
}));

let accountId: string;

async function makeTicket(overrides: Partial<typeof tickets.$inferInsert> = {}) {
  const [ticket] = await db
    .insert(tickets)
    .values({
      subject: "Car from Newark to Manhattan on Friday",
      requesterEmail: "jane@customer.example",
      providerThreadId: `th-${Math.random().toString(36).slice(2)}`,
      emailAccountId: accountId,
      status: "OPEN",
      ...overrides,
    })
    .returning();
  await db.insert(messages).values({
    ticketId: ticket.id,
    direction: "INBOUND",
    fromAddress: "jane@customer.example",
    toAddresses: [],
    ccAddresses: [],
    subject: ticket.subject,
    bodyHtml: "<p>Please send a car from Newark airport to midtown on Friday at 9am.</p>",
    providerMessageId: `pm-${Math.random().toString(36).slice(2)}`,
    providerThreadId: ticket.providerThreadId,
    sentAt: new Date(),
  });
  return ticket;
}

const reservationResult = {
  queue: "RESERVATION",
  reservationType: "NEW",
  reservationSource: "INTERNAL",
  confidence: "high",
  reasoning: "Asks for a car from Newark to midtown, both inside the service area.",
};

beforeEach(async () => {
  classifyEmail.mockReset();
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

describe("classifyNewTicket", () => {
  it("stores the labels and marks the ticket as automatically sorted", async () => {
    classifyEmail.mockResolvedValue(reservationResult);
    const ticket = await makeTicket();

    expect(await classifyNewTicket(ticket.id)).toBe(true);

    const [updated] = await db.select().from(tickets).where(eq(tickets.id, ticket.id));
    expect(updated.queue).toBe("RESERVATION");
    expect(updated.reservationType).toBe("NEW");
    expect(updated.reservationSource).toBe("INTERNAL");
    expect(updated.autoClassified).toBe(true);
    expect(updated.classificationReason).toContain("Newark");
    expect(updated.classificationConfidence).toBe("high");
  });

  it("does not overwrite a queue set by a person while the AI was thinking", async () => {
    const ticket = await makeTicket();
    // The agent opens the ticket and files it themselves mid-call.
    classifyEmail.mockImplementation(async () => {
      await db.update(tickets).set({ queue: "DISPATCH" }).where(eq(tickets.id, ticket.id));
      return reservationResult;
    });

    expect(await classifyNewTicket(ticket.id)).toBe(false);

    const [updated] = await db.select().from(tickets).where(eq(tickets.id, ticket.id));
    expect(updated.queue).toBe("DISPATCH");
    expect(updated.autoClassified).toBe(false);
  });

  it("leaves the ticket alone when the model declines to pick a queue", async () => {
    classifyEmail.mockResolvedValue({ ...reservationResult, queue: null });
    const ticket = await makeTicket();

    expect(await classifyNewTicket(ticket.id)).toBe(false);

    const [updated] = await db.select().from(tickets).where(eq(tickets.id, ticket.id));
    expect(updated.queue).toBeNull();
    expect(updated.autoClassified).toBe(false);
  });

  it("never overwrites a queue a person already chose", async () => {
    classifyEmail.mockResolvedValue(reservationResult);
    const ticket = await makeTicket({ queue: "ACCOUNTING" });

    expect(await classifyNewTicket(ticket.id)).toBe(false);
    expect(classifyEmail).not.toHaveBeenCalled();

    const [updated] = await db.select().from(tickets).where(eq(tickets.id, ticket.id));
    expect(updated.queue).toBe("ACCOUNTING");
  });

  it("skips bulk mail — newsletters are not support work", async () => {
    classifyEmail.mockResolvedValue(reservationResult);
    const ticket = await makeTicket({ isBulk: true, status: "UNRESOLVED_CLOSED" });

    expect(await classifyNewTicket(ticket.id)).toBe(false);
    expect(classifyEmail).not.toHaveBeenCalled();
  });

  it("does not blow up when the AI call throws", async () => {
    classifyEmail.mockRejectedValue(new Error("API unavailable"));
    const ticket = await makeTicket();

    expect(await classifyNewTicket(ticket.id)).toBe(false);

    const [updated] = await db.select().from(tickets).where(eq(tickets.id, ticket.id));
    expect(updated.queue).toBeNull();
  });

  it("sends the email's own subject, body and sender to the model", async () => {
    classifyEmail.mockResolvedValue(reservationResult);
    const ticket = await makeTicket();

    await classifyNewTicket(ticket.id);

    expect(classifyEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: "Car from Newark to Manhattan on Friday",
        fromAddress: "jane@customer.example",
        bodyHtml: expect.stringContaining("Newark airport"),
      })
    );
  });
});

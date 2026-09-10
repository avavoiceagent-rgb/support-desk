import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { db, pool } from "../../db/client";
import { emailAccounts, messages, tickets } from "../../db/schema";
import { ticketsMissedByTriage } from "../poller";

// Triage used to run only for tickets the poll had just created. Anything that
// interrupted it — a deploy, a timeout at the model — stranded that ticket for
// good, with no queue, no draft and nothing on screen saying it had been
// missed. This is the query that finds them again, and what it must NOT pick
// up matters as much as what it must.

let accountId: string;
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

async function makeTicket(over: Partial<typeof tickets.$inferInsert> = {}) {
  const [ticket] = await db
    .insert(tickets)
    .values({
      subject: "Car from Newark to Manhattan on Friday",
      requesterEmail: "jane@customer.example",
      providerThreadId: `th-${Math.random().toString(36).slice(2)}`,
      emailAccountId: accountId,
      status: "OPEN",
      ...over,
    })
    .returning();
  return ticket;
}

beforeEach(async () => {
  await db.delete(messages);
  await db.delete(tickets);
  await db.delete(emailAccounts);
  const [account] = await db
    .insert(emailAccounts)
    .values({
      provider: "GMAIL",
      email: "desk@example.com",
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

describe("finding tickets nobody sorted", () => {
  it("picks up a recent ticket with no queue", async () => {
    const stranded = await makeTicket({ createdAt: minutesAgo(5) });
    expect(await ticketsMissedByTriage()).toEqual([stranded.id]);
  });

  it("leaves alone a ticket that was sorted", async () => {
    await makeTicket({ createdAt: minutesAgo(5), queue: "RESERVATION" });
    expect(await ticketsMissedByTriage()).toEqual([]);
  });

  it("leaves alone a queue a person chose by hand", async () => {
    // The same guard as above from the other direction: whatever put a queue
    // on the ticket, this must never reach back and overrule it.
    await makeTicket({ createdAt: minutesAgo(5), queue: "ACCOUNTING", autoClassified: false });
    expect(await ticketsMissedByTriage()).toEqual([]);
  });

  it("ignores bulk mail, which is never sorted into a queue anyway", async () => {
    await makeTicket({ createdAt: minutesAgo(5), isBulk: true });
    expect(await ticketsMissedByTriage()).toEqual([]);
  });

  it("does not reach back past the window", async () => {
    // An old ticket sitting in no queue is somebody's decision by now, not an
    // accident, and sorting it weeks later would be the surprising thing.
    await makeTicket({ createdAt: minutesAgo(60 * 5) });
    expect(await ticketsMissedByTriage()).toEqual([]);
  });

  it("covers a window long enough to survive a deploy or an outage", async () => {
    const inWindow = await makeTicket({ createdAt: minutesAgo(90) });
    expect(await ticketsMissedByTriage()).toEqual([inWindow.id]);
  });

  it("takes a bounded number at a time", async () => {
    for (let i = 0; i < 30; i += 1) await makeTicket({ createdAt: minutesAgo(5) });
    const found = await ticketsMissedByTriage();
    expect(found.length).toBe(25);
  });

  it("finds nothing when everything has been sorted", async () => {
    await makeTicket({ createdAt: minutesAgo(5), queue: "RESERVATION" });
    await makeTicket({ createdAt: minutesAgo(20), queue: "DISPATCH" });
    expect(await ticketsMissedByTriage()).toEqual([]);
  });
});

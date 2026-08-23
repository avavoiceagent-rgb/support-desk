import { describe, it, expect } from "vitest";
import { bulkSignalsFor, isAutoReply, isNoReplySender } from "../gmail/gmail.provider";

const h = (pairs: Record<string, string>) => Object.entries(pairs).map(([name, value]) => ({ name, value }));

describe("isAutoReply (bulk / automated mail detection)", () => {
  it("passes ordinary customer mail through", () => {
    expect(isAutoReply(h({ From: "jane@customer.example", Subject: "Where is my driver?" }))).toBe(false);
  });

  it("catches a newsletter that only sets List-Unsubscribe", () => {
    expect(isAutoReply(h({ "List-Unsubscribe": "<https://news.example/u/123>" }))).toBe(true);
  });

  it("catches mailing lists via List-Id and List-Post", () => {
    expect(isAutoReply(h({ "List-Id": "<announce.example.com>" }))).toBe(true);
    expect(isAutoReply(h({ "List-Post": "<mailto:list@example.com>" }))).toBe(true);
  });

  it("catches Precedence: bulk and Precedence: list", () => {
    expect(isAutoReply(h({ Precedence: "bulk" }))).toBe(true);
    expect(isAutoReply(h({ Precedence: "List" }))).toBe(true);
  });

  it("still catches vacation auto-replies", () => {
    expect(isAutoReply(h({ "Auto-Submitted": "auto-replied" }))).toBe(true);
    expect(isAutoReply(h({ "X-Autoreply": "yes" }))).toBe(true);
  });

  it("does not treat Auto-Submitted: no as automated", () => {
    expect(isAutoReply(h({ "Auto-Submitted": "no" }))).toBe(false);
  });

  it("handles missing headers", () => {
    expect(isAutoReply(undefined)).toBe(false);
    expect(isAutoReply([])).toBe(false);
  });
});

describe("isNoReplySender", () => {
  it("catches the usual no-reply spellings", () => {
    for (const a of [
      "noreply@example.com",
      "no-reply@example.com",
      "no_reply@example.com",
      "do-not-reply@example.com",
      "donotreply@example.com",
      "notifications@example.com",
      "notification@example.com",
      "MAILER-DAEMON@example.com",
      "postmaster@example.com",
      "bounces+123@example.com",
    ]) {
      expect(isNoReplySender(a), a).toBe(true);
    }
  });

  it("catches Google's compound service addresses", () => {
    expect(isNoReplySender("Google Apps Script <noreply-apps-scripts-notifications@google.com>")).toBe(true);
  });

  it("reads the address out of a display-name header", () => {
    expect(isNoReplySender('"Acme Alerts" <no-reply@acme.example>')).toBe(true);
  });

  it("leaves real people and real support addresses alone", () => {
    for (const a of [
      "jane@customer.example",
      "Priya Nair <priya@customer.example>",
      "support@partner.example",
      "info@partner.example",
      "bookings@partner.example",
      "reply@customer.example",
    ]) {
      expect(isNoReplySender(a), a).toBe(false);
    }
  });

  it("handles a missing or empty From header", () => {
    expect(isNoReplySender(undefined)).toBe(false);
    expect(isNoReplySender("")).toBe(false);
  });
});

describe("isAutoReply via sender address", () => {
  it("flags mail from a no-reply address even with no List-* headers", () => {
    expect(isAutoReply(h({ From: "noreply-apps-scripts-notifications@google.com", Subject: "Summary of failures" }))).toBe(true);
  });
});

describe("bulkSignalsFor (keeping the evidence, not just the verdict)", () => {
  it("names the header that made the call", () => {
    expect(bulkSignalsFor(h({ "List-Unsubscribe": "<https://news.example/u/123>" }))).toEqual([
      "List-Unsubscribe",
    ]);
    expect(bulkSignalsFor(h({ "List-Id": "<announce.example.com>" }))).toEqual(["List-Id"]);
  });

  it("keeps a short value where the value is the evidence", () => {
    // "Precedence: bulk" and "Precedence: junk" are different stories.
    expect(bulkSignalsFor(h({ Precedence: "bulk" }))).toEqual(["Precedence: bulk"]);
    expect(bulkSignalsFor(h({ "Auto-Submitted": "auto-generated" }))).toEqual([
      "Auto-Submitted: auto-generated",
    ]);
  });

  it("drops a value too long to read", () => {
    // A List-Unsubscribe is a URL. Pasting it into a badge tooltip tells a
    // dispatcher nothing the header name did not already say.
    const long = "<https://news.example/unsubscribe?token=" + "a".repeat(80) + ">";
    expect(bulkSignalsFor(h({ "Auto-Submitted": long }))).toEqual(["Auto-Submitted"]);
  });

  it("lists every marker, not just the first", () => {
    // A real newsletter usually sets several. Stopping at the first would
    // make two quite different senders look identical afterwards.
    expect(
      bulkSignalsFor(
        h({
          From: "Acme News <no-reply@news.acme.example>",
          Precedence: "bulk",
          "List-Unsubscribe": "<https://news.acme.example/u>",
          "List-Id": "<news.acme.example>",
        })
      )
    ).toEqual(["Precedence: bulk", "List-Unsubscribe", "List-Id", "no-reply sender"]);
  });

  it("returns nothing for the newsletter that hid its headers", () => {
    // This is ticket #60: Railway's product mail, from a local part of
    // "hello", carrying none of the six markers. An empty list is the honest
    // answer and the one that explains why it sat open for two days.
    expect(
      bulkSignalsFor(
        h({
          From: "Railway <hello@news.railway.app>",
          Subject: "Railway for Everyone, Cloud Agents Everywhere",
        })
      )
    ).toEqual([]);
  });

  it("agrees with isAutoReply, which is now just 'did anything say bulk'", () => {
    const cases = [
      h({ From: "jane@customer.example" }),
      h({ Precedence: "bulk" }),
      h({ "Auto-Submitted": "no" }),
      h({ From: "bounces@mailer.example" }),
    ];
    for (const headers of cases) {
      expect(isAutoReply(headers)).toBe(bulkSignalsFor(headers).length > 0);
    }
  });
});

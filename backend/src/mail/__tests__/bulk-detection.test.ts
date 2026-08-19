import { describe, it, expect } from "vitest";
import { isAutoReply, isNoReplySender } from "../gmail/gmail.provider";

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

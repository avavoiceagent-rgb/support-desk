import { describe, it, expect } from "vitest";
import { isAutoReply } from "../gmail/gmail.provider";

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

import { describe, it, expect } from "vitest";
import { toIsoUtc } from "../ticket.service";

describe("toIsoUtc", () => {
  it("tags a naive Postgres timestamp as UTC instead of letting the browser guess", () => {
    // This is the exact shape a raw min(sent_at) aggregate comes back as.
    expect(toIsoUtc("2026-08-19 23:07:44.448")).toBe("2026-08-19T23:07:44.448Z");
  });

  it("handles a naive timestamp with no fractional seconds", () => {
    expect(toIsoUtc("2026-08-19 23:07:44")).toBe("2026-08-19T23:07:44.000Z");
  });

  it("leaves a Date alone", () => {
    const d = new Date("2026-08-19T23:07:44.448Z");
    expect(toIsoUtc(d)).toBe("2026-08-19T23:07:44.448Z");
  });

  it("does not double-tag a value that already carries a zone", () => {
    expect(toIsoUtc("2026-08-19T23:07:44.448Z")).toBe("2026-08-19T23:07:44.448Z");
    expect(toIsoUtc("2026-08-19T23:07:44.448+02:00")).toBe("2026-08-19T21:07:44.448Z");
  });

  it("returns null for nothing, rather than an Invalid Date", () => {
    expect(toIsoUtc(null)).toBeNull();
    expect(toIsoUtc(undefined)).toBeNull();
    expect(toIsoUtc("")).toBeNull();
    expect(toIsoUtc("not a timestamp")).toBeNull();
  });
});

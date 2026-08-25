import { describe, it, expect } from "vitest";
import { customerPriceCents, marginPercent, money, parseMoney } from "../margin";

describe("what the customer is charged", () => {
  it("adds the margin to the partner's quote", () => {
    // $210 at 25% is $262.50.
    expect(customerPriceCents(21_000, 25)).toBe(26_250);
    expect(money(customerPriceCents(21_000, 25))).toBe("$262.50");
  });

  it("rounds a half cent up, not down", () => {
    // Rounding our own margin down gives the money away a cent at a time.
    expect(customerPriceCents(1_001, 25)).toBe(1_252);
  });

  it("charges the partner's price when the margin is zero", () => {
    expect(customerPriceCents(21_000, 0)).toBe(21_000);
  });

  it("refuses to price nonsense", () => {
    expect(customerPriceCents(Number.NaN, 25)).toBe(0);
    expect(customerPriceCents(-100, 25)).toBe(0);
  });
});

describe("the configured margin", () => {
  it("falls back rather than selling at a loss", () => {
    expect(marginPercent(Number.NaN)).toBe(25);
    expect(marginPercent(-10)).toBe(25);
  });

  it("takes a real figure as given", () => {
    expect(marginPercent(40)).toBe(40);
    expect(marginPercent(0)).toBe(0);
  });
});

describe("money in and out", () => {
  it("reads a price a person typed", () => {
    expect(parseMoney("210")).toBe(21_000);
    expect(parseMoney("$262.50")).toBe(26_250);
    expect(parseMoney(" 1,250.00 ")).toBe(125_000);
  });

  it("refuses anything that is not a price", () => {
    // This becomes a number on a customer's email. Guessing is not an option.
    expect(parseMoney("about two hundred")).toBeNull();
    expect(parseMoney("210.005")).toBeNull();
    expect(parseMoney("")).toBeNull();
  });

  it("writes thousands readably", () => {
    expect(money(125_000)).toBe("$1,250.00");
    expect(money(0)).toBe("$0.00");
  });
});

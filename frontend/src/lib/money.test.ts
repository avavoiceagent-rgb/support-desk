import { describe, it, expect } from "vitest";
import { money, parseMoney } from "./money";

describe("money on the screen", () => {
  it("writes cents as a price", () => {
    expect(money(26_250)).toBe("$262.50");
    expect(money(21_000)).toBe("$210.00");
    expect(money(125_000)).toBe("$1,250.00");
    expect(money(0)).toBe("$0.00");
  });
});

describe("a price somebody typed", () => {
  it("reads the shapes a person actually types", () => {
    expect(parseMoney("210")).toBe(21_000);
    expect(parseMoney("$262.50")).toBe(26_250);
    expect(parseMoney(" 1,250.00 ")).toBe(125_000);
    expect(parseMoney("210.5")).toBe(21_050);
  });

  it("refuses anything that is not a price", () => {
    // What this returns becomes a number on a customer's invoice.
    expect(parseMoney("about two hundred")).toBeNull();
    expect(parseMoney("210.005")).toBeNull();
    expect(parseMoney("-50")).toBeNull();
    expect(parseMoney("")).toBeNull();
  });
});

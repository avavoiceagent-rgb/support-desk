import { describe, it, expect } from "vitest";
import { parseClassification, toPlainText } from "../classifier";

describe("toPlainText", () => {
  it("prefers the plain-text part when there is one", () => {
    expect(toPlainText("<p>markup</p>", "the plain version")).toBe("the plain version");
  });

  it("strips tags and collapses whitespace when there isn't", () => {
    expect(toPlainText("<p>Pickup   at\n\n<b>JFK</b></p>", "")).toBe("Pickup at JFK");
  });

  it("decodes non-breaking spaces", () => {
    expect(toPlainText("<p>a&nbsp;b</p>")).toBe("a b");
  });
});

describe("parseClassification", () => {
  const good = {
    queue: "RESERVATION",
    reservationType: "NEW",
    reservationSource: "INTERNAL",
    confidence: "high",
    reasoning: "Asks for a car from Newark to Manhattan next Tuesday.",
  };

  it("accepts a well-formed result", () => {
    expect(parseClassification(good)).toEqual(good);
  });

  it("drops reservation sub-labels when the queue is not RESERVATION", () => {
    const r = parseClassification({ ...good, queue: "ACCOUNTING" });
    expect(r).toMatchObject({ queue: "ACCOUNTING", reservationType: null, reservationSource: null });
  });

  it("keeps a null queue null rather than inventing one", () => {
    expect(parseClassification({ ...good, queue: null })?.queue).toBeNull();
  });

  it("rejects values outside the allowed sets", () => {
    const r = parseClassification({
      ...good,
      queue: "BILLING",
      reservationType: "AMENDMENT",
      reservationSource: "PARTNER",
    });
    expect(r).toMatchObject({ queue: null, reservationType: null, reservationSource: null });
  });

  it("falls back to low confidence when it is missing or odd", () => {
    expect(parseClassification({ ...good, confidence: "certain" })?.confidence).toBe("low");
    expect(parseClassification({ ...good, confidence: undefined })?.confidence).toBe("low");
  });

  it("truncates a runaway reasoning string", () => {
    const r = parseClassification({ ...good, reasoning: "x".repeat(900) });
    expect(r?.reasoning.length).toBe(500);
  });

  it("copes with junk input", () => {
    expect(parseClassification(null)).toBeNull();
    expect(parseClassification("nope")).toBeNull();
    expect(parseClassification({})).toMatchObject({ queue: null, reasoning: "" });
  });
});

import { describe, it, expect } from "vitest";
import { buildBrief, cleanBody } from "../compose";
import { parseRateEstimate, describeRate } from "../rates";
import { planPickup } from "../pickup-time";
import type { BookingReview } from "../questions";

const review = (over: Partial<BookingReview> = {}): BookingReview => ({
  confirmations: ["Booker: Daniel Weiss", "Pickup: 245 Park Ave, New York, NY 10167, USA"],
  questions: ["the passenger's name", "a contact number for the day of travel"],
  internalNotes: [],
  vehicleSuggestion: null,
  ...over,
});

const brief = (over: Parameters<typeof buildBrief>[0] extends infer T ? Partial<T> : never = {}) =>
  buildBrief({
    review: review(),
    plan: planPickup({
      requestedPickupLocal: null,
      flightDepartsLocal: null,
      flightKind: null,
      driveMinutes: null,
    }),
    rate: null,
    customerName: "Daniel Weiss",
    isExternal: false,
    agentName: "Kruti",
    ...over,
  });

describe("buildBrief", () => {
  it("hands over the confirmed facts and the open questions", () => {
    const b = brief();
    expect(b).toContain("Booker: Daniel Weiss");
    expect(b).toContain("- the passenger's name");
    expect(b).toContain("AGENT SIGNING: Kruti");
  });

  it("says plainly when the trip must not be promised", () => {
    expect(brief({ isExternal: true })).toContain("TRIP IS EXTERNAL (partner-covered, do not promise a vehicle): yes");
  });

  it("explains the timing so the email can give a reason, not just a time", () => {
    const b = brief({
      plan: planPickup({
        requestedPickupLocal: null,
        flightDepartsLocal: "2026-09-22T18:00",
        flightKind: "INTERNATIONAL",
        driveMinutes: 50,
      }),
    });
    expect(b).toContain("3 hours before the flight");
    expect(b).toContain("about 50 minutes in current traffic");
    // 18:00 flight − 3h = 15:00 at the airport, − 50 min drive = 14:10.
    expect(b).toContain("Suggested pickup: Tuesday 22 September, 2:10 PM");
  });

  it("flags a pickup that would make them late, in the strongest terms available", () => {
    const b = brief({
      plan: planPickup({
        requestedPickupLocal: "2026-09-22T15:00",
        flightDepartsLocal: "2026-09-22T18:00",
        flightKind: "INTERNATIONAL",
        driveMinutes: 50,
      }),
    });
    expect(b).toContain("IMPORTANT");
    expect(b).toContain("50 minutes too late");
  });

  it("includes the stop allowance when there is one", () => {
    const b = brief({
      plan: planPickup({
        requestedPickupLocal: null,
        flightDepartsLocal: "2026-09-22T18:00",
        flightKind: "DOMESTIC",
        driveMinutes: 40,
        stopDurationsMinutes: [null, 30],
      }),
    });
    expect(b).toContain("Allowing 45 minutes for the stop(s)");
  });

  it("omits the timing section entirely when there is nothing to say", () => {
    expect(brief()).not.toContain("TIMING:");
  });

  it("labels a rate as a guide rather than a quote", () => {
    const rate = parseRateEstimate({
      low: 95,
      high: 140,
      currency: "USD",
      basis: "sedan, one way, before tolls and gratuity",
      sources: [{ title: "Example Car Service rates", url: "https://example.com/rates" }],
    });
    const b = brief({ rate });
    expect(b).toContain("never our quote");
    expect(b).toContain("$95–$140");
  });

  it("says when nothing is known rather than leaving the model to fill in", () => {
    const b = brief({ review: review({ confirmations: [], questions: [] }) });
    expect(b).toContain("(nothing established yet)");
    expect(b).toContain("(nothing — everything needed is confirmed)");
  });
});

describe("parseRateEstimate", () => {
  const good = {
    low: 95,
    high: 140,
    currency: "usd",
    basis: "sedan, one way",
    sources: [{ title: "Rates", url: "https://example.com/rates" }],
  };

  it("accepts a sensible sourced range", () => {
    expect(parseRateEstimate(good)).toMatchObject({ low: 95, high: 140, currency: "USD" });
  });

  it("refuses a figure with no source to check it against", () => {
    expect(parseRateEstimate({ ...good, sources: [] })).toBeNull();
  });

  it("refuses a one-sided or inverted range", () => {
    expect(parseRateEstimate({ ...good, high: undefined })).toBeNull();
    expect(parseRateEstimate({ ...good, low: 200, high: 100 })).toBeNull();
  });

  it("refuses a range so wide it tells the customer nothing", () => {
    expect(parseRateEstimate({ ...good, low: 20, high: 400 })).toBeNull();
  });

  it("drops sources that are not real links", () => {
    const r = parseRateEstimate({
      ...good,
      sources: [{ title: "x", url: "not-a-url" }, { title: "ok", url: "https://example.com" }],
    });
    expect(r?.sources).toEqual([{ title: "ok", url: "https://example.com" }]);
  });

  it("copes with junk", () => {
    expect(parseRateEstimate(null)).toBeNull();
    expect(parseRateEstimate({})).toBeNull();
  });
});

describe("describeRate", () => {
  it("always hedges and promises our own price separately", () => {
    const text = describeRate(parseRateEstimate({
      low: 95,
      high: 140,
      currency: "USD",
      basis: "sedan, one way, before tolls and gratuity",
      sources: [{ title: "Rates", url: "https://example.com" }],
    }));
    expect(text).toContain("rough guide");
    expect(text).toContain("confirm our own price separately");
  });

  it("says nothing when there is no estimate", () => {
    expect(describeRate(null)).toBeNull();
  });
});

describe("cleanBody", () => {
  it("keeps ordinary reply markup", () => {
    const html = "<p>Thanks for getting in touch — I'm setting this up now.</p><ul><li>Pickup: 245 Park Ave</li></ul>";
    expect(cleanBody(html)).toBe(html);
  });

  it("strips a document wrapper or code fence the model shouldn't have added", () => {
    const out = cleanBody("```html<html><body><p>Thanks for getting in touch, I am setting this up.</p></body></html>```");
    expect(out).toBe("<p>Thanks for getting in touch, I am setting this up.</p>");
  });

  it("rejects an empty or trivially short body", () => {
    expect(cleanBody("")).toBeNull();
    expect(cleanBody("<p>ok</p>")).toBeNull();
    expect(cleanBody(null)).toBeNull();
  });
});

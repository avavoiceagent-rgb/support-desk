import { describe, it, expect } from "vitest";
import { buildBrief, cleanBody, unexpectedEmails } from "../compose";
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
    // 18:00 flight − 3h = 15:00 at the airport, − 50 min drive − the 15 min
    // traffic cushion = 13:55.
    expect(b).toContain("Suggested pickup: Tuesday 22 September, 1:55 PM");
    expect(b).toContain("15 minutes of our own on top of the drive");
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
    // 50 against the bare arithmetic, 65 once the cushion is in it.
    expect(b).toContain("65 minutes too late");
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

describe("unexpectedEmails", () => {
  it("catches an address the draft invented", () => {
    // Ticket #73: "is amarpant30@gmail.com the best way to reach you on the
    // day" — from a brief that contained no address at all.
    const brief = "CONFIRMED:\n- Pickup: 1 Kalisa Way\n\nSTILL NEEDED:\n- a mobile number";
    const body = "<p>Is amarpant30@gmail.com the best way to reach you?</p>";
    expect(unexpectedEmails(body, brief)).toEqual(["amarpant30@gmail.com"]);
  });

  it("says nothing about an address that was in the brief", () => {
    const brief = "CONFIRMED:\n- Booker email: ana@customer.example";
    const body = "<p>We will send updates to ana@customer.example.</p>";
    expect(unexpectedEmails(body, brief)).toEqual([]);
  });

  it("ignores case, since a model may retype it differently", () => {
    const brief = "- Booker email: Ana@Customer.example";
    expect(unexpectedEmails("<p>ana@customer.example</p>", brief)).toEqual([]);
  });

  it("says nothing about an ordinary draft", () => {
    const body = "<p>Thank you for getting in touch. Your pickup is at 2:55 PM.</p>";
    expect(unexpectedEmails(body, "CONFIRMED:\n- Pickup: 1 Kalisa Way")).toEqual([]);
  });

  it("reports each address once", () => {
    const body = "<p>a@b.example and again a@b.example and c@d.example</p>";
    expect(unexpectedEmails(body, "")).toEqual(["a@b.example", "c@d.example"]);
  });
});

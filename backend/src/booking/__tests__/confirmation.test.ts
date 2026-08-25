import { describe, it, expect } from "vitest";
import { DateTime } from "luxon";
import {
  confirmationEmail,
  changeConfirmationEmail,
  changesWorthTelling,
  detailLines,
  type ConfirmableTrip,
} from "../confirmation";
import { OPERATING_TIME_ZONE } from "../pickup-time";

const at = (iso: string) => DateTime.fromISO(iso, { zone: OPERATING_TIME_ZONE }).toJSDate();

function trip(over: Partial<ConfirmableTrip> = {}): ConfirmableTrip {
  return {
    reference: "T-10311",
    passengerName: "Apurva Patel",
    passengerPhone: "201-555-0134",
    pickupAddress: "1 Kalisa Way, Paramus, NJ 07652",
    dropoffAddress: "LaGuardia Airport (LGA), East Elmhurst, NY 11371",
    stops: [],
    pickupAt: at("2026-09-03T13:55"),
    bookedHours: 3,
    vehicleClass: "SEDAN",
    passengerCount: 1,
    luggageCount: 2,
    flightNumber: null,
    flightAt: at("2026-09-03T17:45"),
    flightKind: "INTERNATIONAL",
    ...over,
  };
}

describe("the confirmation email", () => {
  it("states the booking in the customer's own time zone", () => {
    const body = confirmationEmail(trip());

    expect(body).toContain("T-10311");
    expect(body).toContain("Thursday 3 September 2026 at 1:55 PM");
    expect(body).toContain("1 Kalisa Way");
    expect(body).toContain("Sedan");
    expect(body).toContain("201-555-0134");
  });

  it("greets by first name and adds no title", () => {
    const body = confirmationEmail(trip());

    expect(body).toContain("<p>Hi Apurva,</p>");
    expect(body).not.toMatch(/\bMr\b|\bMs\b|\bMrs\b/);
  });

  it("promises a partner's car rather than ours when the job is farmed out", () => {
    const body = confirmationEmail(trip({ affiliateCompany: "Liberty Bell Executive" }));

    expect(body).toContain("partner operator");
    expect(body).not.toContain("your driver's name");
  });

  it("leaves out counts nobody gave us", () => {
    const lines = detailLines(trip({ passengerCount: null, luggageCount: null }));

    expect(lines.join(" ")).not.toContain("Party");
  });

  it("writes a real zero in words", () => {
    // "0 bags" is how a database talks. Live on T-10306 it read
    // "3 passengers, 0 bags", which looks like something we failed to fill in.
    const lines = detailLines(trip({ passengerCount: 3, luggageCount: 0 }));

    expect(lines.join(" ")).toContain("Party: 3 passengers, no bags");
  });

  it("says nothing about a flight when there is none", () => {
    const lines = detailLines(trip({ flightAt: null, flightNumber: null }));

    expect(lines.join(" ")).not.toContain("Flight");
  });

  it("escapes an address that contains markup", () => {
    const body = confirmationEmail(trip({ pickupAddress: "1 Kalisa Way <script>x</script>" }));

    expect(body).not.toContain("<script>");
    expect(body).toContain("&lt;script&gt;");
  });
});

describe("the change confirmation", () => {
  const moved = [{ field: "Pickup", from: "3 Sep 2026, 2:55 PM", to: "3 Sep 2026, 1:55 PM" }];

  it("names what moved and then restates the whole booking", () => {
    const body = changeConfirmationEmail(trip(), moved);

    expect(body).toContain("updated your booking T-10311");
    expect(body).toContain("2:55 PM → 3 Sep 2026, 1:55 PM");
    expect(body).toContain("Thursday 3 September 2026 at 1:55 PM");
  });

  it("keeps our own business out of the customer's email", () => {
    // Who is driving and what the dispatcher wrote in the notes are ours.
    const told = changesWorthTelling([
      { field: "Driver", from: "Unassigned", to: "Marco Rinaldi" },
      { field: "Notes", from: null, to: "Meet at door 3" },
      { field: "Pickup", from: "2:55 PM", to: "1:55 PM" },
    ]);

    expect(told.map((c) => c.field)).toEqual(["Pickup"]);
  });
});

describe("the price on a confirmation", () => {
  it("states it once it is settled", () => {
    const body = confirmationEmail(trip({ customerPriceCents: 26_250 }));
    expect(body).toContain("Price: $262.50");
  });

  it("says nothing at all until it is", () => {
    // A farmed-out job has no price until a partner quotes and we take it.
    // "Price: TBC" on a confirmation is worse than no line.
    const lines = detailLines(trip({ customerPriceCents: null }));
    expect(lines.join(" ")).not.toContain("Price");
  });
});

describe("which form a caller gets", () => {
  // T-10313. The booking was created before any partner had quoted, so by the
  // time $300 was agreed and Liberty Bell had accepted, the last thing in the
  // trip's history was an assignment. Left to infer, the desk would have
  // written "we have updated your booking" — listing nothing — to a customer
  // who had never been sent a confirmation at all.
  it("restates the whole booking when asked for the full one", () => {
    const body = confirmationEmail(trip({ customerPriceCents: 37_500 }));
    expect(body).toContain("Your booking is confirmed");
    expect(body).toContain("Price: $375.00");
    expect(body).not.toContain("updated your booking");
  });

  it("has nothing to tell a customer about who is driving", () => {
    expect(
      changesWorthTelling([{ field: "Partner", from: "None", to: "Liberty Bell Executive" }])
    ).toEqual([]);
  });
});

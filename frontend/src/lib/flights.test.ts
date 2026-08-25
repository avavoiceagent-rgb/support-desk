import { describe, it, expect } from "vitest";
import { allowanceFrom, lateChangeWarning, type FlightBooking } from "./flights";
import { fromDateTimeInput } from "./time";

// T-10311 as the desk holds it: a 5:45 PM international departure out of LGA,
// collected at 1:55 PM. Check-in closes at 2:45 PM, so the drive and its
// cushion came to 50 minutes.
const booking: FlightBooking = {
  flightAt: fromDateTimeInput("2026-09-03T17:45"),
  flightKind: "INTERNATIONAL",
  pickupAt: fromDateTimeInput("2026-09-03T13:55"),
};

describe("what the booking allowed for the drive", () => {
  it("reads it back off the booking rather than asking Google again", () => {
    expect(allowanceFrom(booking)).toBe(50);
  });

  it("reads an unstated kind as international, like the draft does", () => {
    expect(allowanceFrom({ ...booking, flightKind: null })).toBe(50);
  });

  it("is nothing on a booking with no flight", () => {
    expect(allowanceFrom({ ...booking, flightAt: null })).toBe(0);
  });
});

describe("moving a booking that has a flight on it", () => {
  it("says nothing when the new time still makes it", () => {
    expect(lateChangeWarning(booking, "2026-09-03T12:30")).toBeNull();
    // Exactly on time is on time.
    expect(lateChangeWarning(booking, "2026-09-03T13:55")).toBeNull();
  });

  it("says how late, and by when they would have to leave", () => {
    // The case that started this: a customer asks for 4:00 PM against a
    // 5:45 PM international departure. The desk saved it, told the driver, and
    // emailed a confirmation of a time that misses check-in.
    const warning = lateChangeWarning(booking, "2026-09-03T16:00");

    expect(warning).toContain("125 minutes too late");
    expect(warning).toContain("5:45 PM international flight");
    expect(warning).toContain("by 2:45 PM");
    expect(warning).toContain("Leaving by 1:55 PM makes it");
    // A flight can be missed on purpose — rebooked, or already checked in.
    expect(warning).toContain("Save anyway");
  });

  it("treats an unknown flight kind as the tighter of the two", () => {
    // Silence would be the dangerous answer here: read as domestic, a 3:00 PM
    // pickup looks fine, and if it turns out to be international it is an
    // hour late.
    expect(lateChangeWarning({ ...booking, flightKind: null }, "2026-09-03T15:00")).toContain(
      "too late"
    );
  });

  it("uses the shorter deadline for a domestic flight", () => {
    // A domestic booking of the same flight, timed as one: check-in closes at
    // 3:45 PM rather than 2:45, so the same 50-minute drive is collected at
    // 2:55 PM.
    const domestic: FlightBooking = {
      flightAt: fromDateTimeInput("2026-09-03T17:45"),
      flightKind: "DOMESTIC",
      pickupAt: fromDateTimeInput("2026-09-03T14:55"),
    };
    expect(allowanceFrom(domestic)).toBe(50);
    expect(lateChangeWarning(domestic, "2026-09-03T14:30")).toBeNull();
    expect(lateChangeWarning(domestic, "2026-09-03T16:00")).toContain("65 minutes too late");
  });

  it("reads the drive from the kind the booking was actually built under", () => {
    // Not a rounding detail. The same 1:55 PM pickup means a 50-minute drive
    // against a 2:45 international deadline and a 110-minute one against a
    // 3:45 domestic deadline — and the warning has to measure the new time
    // against the booking as it stands, not as somebody might reclassify it.
    expect(allowanceFrom({ ...booking, flightKind: "DOMESTIC" })).toBe(110);
  });
});

describe("when it has nothing honest to say", () => {
  it("stays quiet on a booking with no flight", () => {
    // T-10310, which predates flight capture. Silence here means "no
    // objection", and that is the truth: there is no flight to be late for.
    expect(lateChangeWarning({ ...booking, flightAt: null }, "2026-09-03T23:00")).toBeNull();
  });

  it("stays quiet on an empty box", () => {
    expect(lateChangeWarning(booking, "")).toBeNull();
  });
});

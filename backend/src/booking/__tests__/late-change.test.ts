import { describe, it, expect } from "vitest";
import { DateTime } from "luxon";
import { allowanceFrom, lateChangeWarning } from "../late-change";
import { OPERATING_TIME_ZONE } from "../pickup-time";

const at = (iso: string) => DateTime.fromISO(iso, { zone: OPERATING_TIME_ZONE }).toJSDate();

// T-10311, as the desk actually holds it: a 5:45 PM international departure
// out of LGA, collected at 1:55 PM. Check-in closes at 2:45 PM, so the drive
// and its cushion came to 50 minutes.
const FLIGHT = at("2026-09-03T17:45");
const OLD_PICKUP = at("2026-09-03T13:55");

describe("what the booking allowed for the drive", () => {
  it("recovers it from the booking rather than asking Google again", () => {
    expect(allowanceFrom(OLD_PICKUP, FLIGHT, "INTERNATIONAL")).toBe(50);
  });

  it("reads an unstated kind as international, like the draft does", () => {
    expect(allowanceFrom(OLD_PICKUP, FLIGHT, null)).toBe(50);
  });

  it("is nothing at all on a booking with no flight", () => {
    expect(allowanceFrom(OLD_PICKUP, null, null)).toBe(0);
  });
});

describe("moving a booking that has a flight on it", () => {
  const booking = { flightAt: FLIGHT, flightKind: "INTERNATIONAL" as const, allowanceMinutes: 50 };

  it("says nothing when the new time still makes it", () => {
    expect(lateChangeWarning({ ...booking, pickupAtLocal: "2026-09-03T12:30" })).toBeNull();
    // Exactly on time is on time.
    expect(lateChangeWarning({ ...booking, pickupAtLocal: "2026-09-03T13:55" })).toBeNull();
  });

  it("says how late, and by when they would have to leave", () => {
    // The case that started this: a customer asks for 4:00 PM against a 5:45
    // PM international departure. The desk used to save it, tell the driver,
    // and email a confirmation of a time that misses check-in.
    const warning = lateChangeWarning({ ...booking, pickupAtLocal: "2026-09-03T16:00" });

    expect(warning).toContain("125 minutes too late");
    expect(warning).toContain("5:45 PM international flight");
    expect(warning).toContain("by 2:45 PM");
    expect(warning).toContain("Leaving by 1:55 PM makes it");
  });

  it("still lets a person save it", () => {
    // A flight can be missed on purpose — rebooked, or already checked in.
    const warning = lateChangeWarning({ ...booking, pickupAtLocal: "2026-09-03T16:00" });
    expect(warning).toContain("Save anyway");
  });

  it("treats an unknown flight kind as the tighter of the two", () => {
    // Silence would be the dangerous answer here: read as domestic, a 3:00 PM
    // pickup looks fine, and if the flight turns out to be international it
    // is an hour late.
    const warning = lateChangeWarning({
      ...booking,
      flightKind: null,
      pickupAtLocal: "2026-09-03T15:00",
    });
    expect(warning).toContain("too late");
  });
});

describe("when it has nothing honest to say", () => {
  it("stays quiet on a booking with no flight", () => {
    // T-10310, which predates flight capture. Silence here means "no
    // objection" and that is the truth: there is no flight to be late for.
    expect(
      lateChangeWarning({
        pickupAtLocal: "2026-09-03T23:00",
        flightAt: null,
        flightKind: null,
        allowanceMinutes: 0,
      })
    ).toBeNull();
  });

  it("stays quiet on a time it cannot read", () => {
    expect(
      lateChangeWarning({
        pickupAtLocal: "later that afternoon",
        flightAt: FLIGHT,
        flightKind: "INTERNATIONAL",
        allowanceMinutes: 50,
      })
    ).toBeNull();
  });
});

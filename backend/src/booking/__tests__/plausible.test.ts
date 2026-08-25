import { describe, it, expect } from "vitest";
import { implausible, LONGEST_PLAUSIBLE_DRIVE_MINUTES } from "../plausible";

// Ticket #79, as it actually went out. The customer typed "JFK"; Google
// returned John F. Kennedy in Oklahoma City and did not flag it as a guess.
const OKLAHOMA = {
  driveMinutes: 1341,
  dropoffDescription: "John F. Kennedy, Oklahoma City, OK 73117",
  pickupAtLocal: "2026-10-19T18:50",
  flightAtLocal: "2026-10-20T20:30",
};

describe("the drive nobody would take", () => {
  it("catches the Oklahoma booking on the drive alone", () => {
    const [first] = implausible(OKLAHOMA);
    expect(first).toContain("22.4 hours");
    expect(first).toContain("Oklahoma City");
  });

  it("says it twice, because the two say different things", () => {
    // One names the drive, the other names the day. A reader who sees both
    // knows immediately that it is the address rather than the times.
    const problems = implausible(OKLAHOMA);
    expect(problems).toHaveLength(2);
    expect(problems[1]).toContain("Monday 19 October");
    expect(problems[1]).toContain("Tuesday 20 October");
  });

  it("leaves an ordinary airport run alone", () => {
    // Paramus to LGA: 40 minutes, collected the same afternoon.
    expect(
      implausible({
        driveMinutes: 40,
        pickupAtLocal: "2026-09-03T13:55",
        flightAtLocal: "2026-09-03T17:45",
      })
    ).toEqual([]);
  });

  it("leaves a long but real out-of-area job alone", () => {
    // Manhattan to Washington is the far end of what the partner network
    // covers, and it is a booking, not a mistake.
    expect(implausible({ driveMinutes: 230 })).toEqual([]);
  });

  it("draws the line where it says it does", () => {
    expect(implausible({ driveMinutes: LONGEST_PLAUSIBLE_DRIVE_MINUTES })).toEqual([]);
    expect(implausible({ driveMinutes: LONGEST_PLAUSIBLE_DRIVE_MINUTES + 1 })).toHaveLength(1);
  });
});

describe("a pickup on the wrong day", () => {
  it("catches it even when the drive looks fine", () => {
    // The drive alone would not have caught a smaller geocode error. The day
    // is a second, independent reading of the same arithmetic.
    const problems = implausible({
      driveMinutes: 90,
      pickupAtLocal: "2026-10-19T23:30",
      flightAtLocal: "2026-10-20T06:00",
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("day before a flight");
  });

  it("says nothing about a trip with no flight", () => {
    expect(implausible({ driveMinutes: 90, pickupAtLocal: "2026-10-19T23:30" })).toEqual([]);
  });
});

describe("when it cannot tell", () => {
  it("stays quiet rather than guessing", () => {
    // Silence has to mean "no objection". A missing drive time is maps being
    // switched off or a route that would not compute, and neither is evidence
    // of anything being wrong.
    expect(implausible({ driveMinutes: null })).toEqual([]);
    expect(implausible({ driveMinutes: Number.NaN })).toEqual([]);
    expect(
      implausible({ driveMinutes: 60, pickupAtLocal: "nonsense", flightAtLocal: "also nonsense" })
    ).toEqual([]);
  });
});

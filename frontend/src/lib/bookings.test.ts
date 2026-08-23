import { describe, it, expect } from "vitest";
import { alreadyHappened, pastBookingWarning } from "./bookings";

const NOW = new Date("2026-08-23T16:00:00.000Z"); // noon in New York

describe("whether a booking has already happened", () => {
  it("reads the status before the clock", () => {
    // A job cancelled for next Tuesday is still not something you move by
    // editing its pickup time.
    const nextWeek = { status: "CANCELLED", pickupAt: "2026-09-01T13:00:00.000Z" };
    expect(alreadyHappened(nextWeek, NOW)).toBe("has been cancelled");
  });

  it("names what happened, and when", () => {
    expect(alreadyHappened({ status: "COMPLETED", pickupAt: "2026-07-23T20:30:00.000Z" }, NOW))
      .toBe("was completed on 23 Jul 2026");
    expect(alreadyHappened({ status: "NO_SHOW", pickupAt: "2026-07-23T20:30:00.000Z" }, NOW))
      .toBe("was recorded as a no-show on 23 Jul 2026");
    expect(alreadyHappened({ status: "IN_PROGRESS", pickupAt: "2026-08-23T15:00:00.000Z" }, NOW))
      .toBe("is out on the road now");
  });

  it("notices a scheduled job whose hour has gone by", () => {
    const missed = { status: "SCHEDULED", pickupAt: "2026-08-23T13:00:00.000Z" };
    expect(alreadyHappened(missed, NOW)).toMatch(/was due at Sun 23 Aug, 9:00 AM, which has passed/);
  });

  it("says nothing about a booking still ahead", () => {
    expect(alreadyHappened({ status: "SCHEDULED", pickupAt: "2026-08-24T13:00:00.000Z" }, NOW))
      .toBeNull();
  });
});

describe("the warning itself", () => {
  it("says what changing it now actually does", () => {
    const warning = pastBookingWarning(
      { status: "COMPLETED", pickupAt: "2026-07-23T20:30:00.000Z" },
      "T-10005",
      NOW
    );
    expect(warning).toContain("T-10005 was completed on 23 Jul 2026");
    expect(warning).toContain("corrects the record rather than moving a car");
  });

  it("stays quiet for a booking that has not happened", () => {
    expect(
      pastBookingWarning({ status: "SCHEDULED", pickupAt: "2026-08-24T13:00:00.000Z" }, "T-1", NOW)
    ).toBeNull();
  });
});

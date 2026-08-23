import { describe, it, expect } from "vitest";
import {
  startOfDayIso, endOfDayIso, dayStartMs, toDateInput, toDateTimeInput,
  fromDateTimeInput, instantFromInput, shiftDate, when, atTime, onDate, span,
  zonedToUtc, OPERATING_TIME_ZONE,
} from "./time";

// These ran once, as a script, in a sandbox that no longer exists. That was
// the whole of the verification for a file doing DST arithmetic — where a
// wrong answer moves a real booking by an hour and nothing looks broken.
//
// Everything here is pure and needs only `Intl`, so none of it needs a
// browser. The clock changes used throughout are the real 2026 ones for New
// York: forward on 8 March, back on 1 November.

describe("the operating zone is fixed, not the reader's", () => {
  it("is New York whatever the machine says", () => {
    expect(OPERATING_TIME_ZONE).toBe("America/New_York");
  });

  it("renders an instant in New York, not locally", () => {
    // The bug that started all this: a laptop in Berlin showed 11:15 PM for a
    // job the customer had been told was at 7:15 PM.
    expect(when("2026-08-22T23:15:00.000Z")).toBe("Sat 22 Aug, 7:15 PM");
    expect(atTime("2026-08-22T21:00:00.000Z")).toBe("5:00 PM");
    expect(onDate("2026-08-22T23:15:00.000Z")).toBe("22 Aug 2026");
  });

  it("puts a late-evening instant on the day New York is having", () => {
    // 01:00Z on the 23rd is still the evening of the 22nd where the car is.
    expect(toDateInput("2026-08-23T01:00:00.000Z")).toBe("2026-08-22");
  });
});

describe("a day starts at midnight in New York", () => {
  it("in summer and in winter", () => {
    expect(startOfDayIso("2026-08-22")).toBe("2026-08-22T04:00:00.000Z");
    expect(startOfDayIso("2026-01-15")).toBe("2026-01-15T05:00:00.000Z");
  });

  it("ends a millisecond before the next one", () => {
    // The offset is read off a formatter that stops at seconds, so the
    // milliseconds are held back and added afterwards. Without that this
    // returned ...04:00:00.997Z.
    expect(endOfDayIso("2026-08-22")).toBe("2026-08-23T03:59:59.999Z");
  });

  it("gets both clock changes right", () => {
    expect(startOfDayIso("2026-03-08")).toBe("2026-03-08T05:00:00.000Z");
    expect(startOfDayIso("2026-03-09")).toBe("2026-03-09T04:00:00.000Z");
    expect(startOfDayIso("2026-11-01")).toBe("2026-11-01T04:00:00.000Z");
    expect(startOfDayIso("2026-11-02")).toBe("2026-11-02T05:00:00.000Z");
  });

  it("makes the short day 23 hours and the long day 25", () => {
    const hours = (a: string, b: string) => (dayStartMs(b) - dayStartMs(a)) / 3_600_000;
    expect(hours("2026-03-08", "2026-03-09")).toBe(23);
    expect(hours("2026-11-01", "2026-11-02")).toBe(25);
  });
});

describe("stepping between dates", () => {
  it("steps by the calendar, not by 24 hours", () => {
    // Adding milliseconds through a 23- or 25-hour day lands on the same date
    // twice, or skips one.
    expect(shiftDate("2026-03-07", 1)).toBe("2026-03-08");
    expect(shiftDate("2026-03-08", 1)).toBe("2026-03-09");
    expect(shiftDate("2026-11-01", 1)).toBe("2026-11-02");
    expect(shiftDate("2026-11-02", -1)).toBe("2026-11-01");
  });

  it("steps across a month and a leap-year February", () => {
    expect(shiftDate("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftDate("2028-02-28", 1)).toBe("2028-02-29");
  });
});

describe("the shift editor's round trip", () => {
  it("shows New York time and reads it back unchanged", () => {
    expect(toDateTimeInput("2026-08-22T21:00:00.000Z")).toBe("2026-08-22T17:00");
    expect(fromDateTimeInput("2026-08-22T17:00")).toBe("2026-08-22T21:00:00.000Z");
  });

  it("survives an ordinary winter time", () => {
    expect(fromDateTimeInput(toDateTimeInput("2026-01-15T14:30:00.000Z"))).toBe(
      "2026-01-15T14:30:00.000Z"
    );
  });
});

describe("the hour that does not exist", () => {
  it("steps forward over the spring-forward gap, never backwards", () => {
    // There is no 02:30 in New York on 8 March 2026. Answering 01:30 — earlier
    // than the time asked for — meant a shift typed as half past two started
    // an hour and a half before anyone meant.
    const got = zonedToUtc(2026, 3, 8, 2, 30).toISOString();
    expect(got).toBe("2026-03-08T07:30:00.000Z");
    expect(new Date(got).getTime()).toBeGreaterThan(
      zonedToUtc(2026, 3, 8, 1, 59).getTime()
    );
  });

  it("leaves the hours either side of the gap alone", () => {
    expect(zonedToUtc(2026, 3, 8, 1, 30).toISOString()).toBe("2026-03-08T06:30:00.000Z");
    expect(zonedToUtc(2026, 3, 8, 3, 30).toISOString()).toBe("2026-03-08T07:30:00.000Z");
  });
});

describe("the hour that happens twice", () => {
  // 01:00 on 1 November comes round twice in New York, and a datetime-local
  // box cannot say which one it means. The information is not in the string,
  // so the answer is not to parse harder — it is not to reinterpret a value
  // nobody edited.
  const secondPass = "2026-11-01T06:00:00.000Z"; // 01:00 EST
  const firstPass = "2026-11-01T05:00:00.000Z"; // 01:00 EDT

  it("shows both occurrences as the same wall clock, which is the problem", () => {
    expect(toDateTimeInput(firstPass)).toBe("2026-11-01T01:00");
    expect(toDateTimeInput(secondPass)).toBe("2026-11-01T01:00");
  });

  it("does not move a booking that nobody edited", () => {
    const shown = toDateTimeInput(secondPass);
    expect(instantFromInput(shown, secondPass)).toBe(secondPass);
    expect(instantFromInput(toDateTimeInput(firstPass), firstPass)).toBe(firstPass);
  });

  it("does read the field again once somebody has changed it", () => {
    expect(instantFromInput("2026-11-01T03:00", secondPass)).toBe("2026-11-01T08:00:00.000Z");
  });

  it("falls back to reading the field when there is nothing to compare with", () => {
    expect(instantFromInput("2026-08-22T17:00")).toBe("2026-08-22T21:00:00.000Z");
    expect(instantFromInput("2026-08-22T17:00", null)).toBe("2026-08-22T21:00:00.000Z");
  });

  it("leaves ordinary times exactly as they were", () => {
    const summer = "2026-08-22T21:00:00.000Z";
    expect(instantFromInput(toDateTimeInput(summer), summer)).toBe(summer);
  });
});

describe("spans", () => {
  it("collapses the date when a shift ends the same day", () => {
    expect(span("2026-08-22T13:00:00.000Z", "2026-08-22T21:00:00.000Z")).toBe(
      "Sat 22 Aug, 9:00 AM – 5:00 PM"
    );
  });

  it("keeps both dates when a night shift runs over", () => {
    expect(span("2026-08-22T21:00:00.000Z", "2026-08-23T08:00:00.000Z")).toBe(
      "Sat 22 Aug, 5:00 PM – Sun 23 Aug, 4:00 AM"
    );
  });
});

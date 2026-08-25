import { describe, it, expect } from "vitest";
import {
  planPickup,
  stopAllowance,
  leadMinutesFor,
  describeLocal,
  DEFAULT_STOP_MINUTES,
} from "../pickup-time";

describe("lead times", () => {
  it("is 2 hours for domestic and 3 for international", () => {
    expect(leadMinutesFor("DOMESTIC")).toBe(120);
    expect(leadMinutesFor("INTERNATIONAL")).toBe(180);
  });
});

describe("stop allowance", () => {
  it("is nothing when there are no stops", () => {
    expect(stopAllowance([])).toBe(0);
    expect(stopAllowance()).toBe(0);
  });

  it("allows 15 minutes for a stop with no stated duration", () => {
    expect(stopAllowance([null])).toBe(DEFAULT_STOP_MINUTES);
    expect(stopAllowance([null, null])).toBe(30);
  });

  it("takes a stated duration at its word", () => {
    expect(stopAllowance([40])).toBe(40);
    expect(stopAllowance([40, null])).toBe(55);
  });

  it("falls back to the default for a nonsense duration", () => {
    expect(stopAllowance([-10])).toBe(DEFAULT_STOP_MINUTES);
    expect(stopAllowance([Number.NaN])).toBe(DEFAULT_STOP_MINUTES);
  });
});

describe("planPickup — domestic departure", () => {
  it("works back from the flight through the 2 hour rule and the drive", () => {
    const plan = planPickup({
      // The rule itself, without the cushion — see the block at the end.
      bufferMinutes: 0,
      requestedPickupLocal: null,
      flightDepartsLocal: "2026-09-22T14:00",
      flightKind: "DOMESTIC",
      driveMinutes: 50,
    });
    // 14:00 − 2h = 12:00 at the airport, − 50 min drive = 11:10.
    expect(plan.mustArriveAtLocal).toBe("2026-09-22T12:00");
    expect(plan.recommendedPickupLocal).toBe("2026-09-22T11:10");
    expect(plan.missing).toEqual([]);
  });
});

describe("planPickup — international departure", () => {
  it("uses the 3 hour rule", () => {
    const plan = planPickup({
      // The rule itself, without the cushion — see the block at the end.
      bufferMinutes: 0,
      requestedPickupLocal: null,
      flightDepartsLocal: "2026-09-22T18:00",
      flightKind: "INTERNATIONAL",
      driveMinutes: 75,
    });
    // 18:00 − 3h = 15:00, − 75 min = 13:45.
    expect(plan.mustArriveAtLocal).toBe("2026-09-22T15:00");
    expect(plan.recommendedPickupLocal).toBe("2026-09-22T13:45");
  });

  it("adds 15 minutes for a stop the customer did not put a time on", () => {
    const plan = planPickup({
      // The rule itself, without the cushion — see the block at the end.
      bufferMinutes: 0,
      requestedPickupLocal: null,
      flightDepartsLocal: "2026-09-22T18:00",
      flightKind: "INTERNATIONAL",
      driveMinutes: 75,
      stopDurationsMinutes: [null],
    });
    expect(plan.stopAllowanceMinutes).toBe(15);
    expect(plan.recommendedPickupLocal).toBe("2026-09-22T13:30");
  });
});

describe("planPickup — checking the time the customer asked for", () => {
  it("flags a requested pickup that would make them late, with the shortfall", () => {
    const plan = planPickup({
      // The rule itself, without the cushion — see the block at the end.
      bufferMinutes: 0,
      requestedPickupLocal: "2026-09-22T15:00",
      flightDepartsLocal: "2026-09-22T18:00",
      flightKind: "INTERNATIONAL",
      driveMinutes: 75,
    });
    expect(plan.recommendedPickupLocal).toBe("2026-09-22T13:45");
    expect(plan.requestedIsTooLate).toBe(true);
    expect(plan.shortfallMinutes).toBe(75);
  });

  it("accepts a requested pickup with time to spare", () => {
    const plan = planPickup({
      // The rule itself, without the cushion — see the block at the end.
      bufferMinutes: 0,
      requestedPickupLocal: "2026-09-22T13:00",
      flightDepartsLocal: "2026-09-22T18:00",
      flightKind: "INTERNATIONAL",
      driveMinutes: 75,
    });
    expect(plan.requestedIsTooLate).toBe(false);
    expect(plan.shortfallMinutes).toBe(-45);
  });

  it("does not call it late when it lands exactly on the recommendation", () => {
    const plan = planPickup({
      // The rule itself, without the cushion — see the block at the end.
      bufferMinutes: 0,
      requestedPickupLocal: "2026-09-22T13:45",
      flightDepartsLocal: "2026-09-22T18:00",
      flightKind: "INTERNATIONAL",
      driveMinutes: 75,
    });
    expect(plan.requestedIsTooLate).toBe(false);
    expect(plan.shortfallMinutes).toBe(0);
  });
});

describe("planPickup — when we cannot finish the sum", () => {
  it("says it needs the departure time", () => {
    const plan = planPickup({
      // The rule itself, without the cushion — see the block at the end.
      bufferMinutes: 0,
      requestedPickupLocal: "2026-09-22T09:00",
      flightDepartsLocal: null,
      flightKind: null,
      driveMinutes: 40,
    });
    expect(plan.recommendedPickupLocal).toBeNull();
    expect(plan.missing).toContain("the flight departure time");
  });

  it("says it needs to know domestic or international", () => {
    const plan = planPickup({
      // The rule itself, without the cushion — see the block at the end.
      bufferMinutes: 0,
      requestedPickupLocal: null,
      flightDepartsLocal: "2026-09-22T18:00",
      flightKind: null,
      driveMinutes: 40,
    });
    expect(plan.recommendedPickupLocal).toBeNull();
    expect(plan.missing).toContain("whether the flight is domestic or international");
  });

  it("says it needs the drive time when the addresses are not verified", () => {
    const plan = planPickup({
      // The rule itself, without the cushion — see the block at the end.
      bufferMinutes: 0,
      requestedPickupLocal: null,
      flightDepartsLocal: "2026-09-22T18:00",
      flightKind: "INTERNATIONAL",
      driveMinutes: null,
    });
    expect(plan.recommendedPickupLocal).toBeNull();
    // It can still say when they need to BE at the airport.
    expect(plan.mustArriveAtLocal).toBe("2026-09-22T15:00");
    expect(plan.missing).toContain("a verified pickup and drop-off address to measure the drive");
  });

  it("never claims a pickup time for a trip that is not an airport departure", () => {
    const plan = planPickup({
      // The rule itself, without the cushion — see the block at the end.
      bufferMinutes: 0,
      requestedPickupLocal: "2026-09-22T09:00",
      flightDepartsLocal: null,
      flightKind: null,
      driveMinutes: 35,
    });
    expect(plan.recommendedPickupLocal).toBeNull();
    expect(plan.requestedIsTooLate).toBe(false);
  });
});

describe("planPickup — daylight saving", () => {
  // US clocks go BACK at 2am on 1 November 2026, so 01:30 happens twice and
  // the small hours of that morning are 25 hours long. Subtracting hours in
  // plain wall-clock arithmetic gets this wrong.
  it("handles a flight the morning the clocks change", () => {
    const plan = planPickup({
      // The rule itself, without the cushion — see the block at the end.
      bufferMinutes: 0,
      requestedPickupLocal: null,
      flightDepartsLocal: "2026-11-01T06:00",
      flightKind: "INTERNATIONAL",
      driveMinutes: 60,
    });
    // The point is that the gaps are THREE and FOUR real hours, not three and
    // four turns of the wall clock. 06:00 EST back three real hours is 03:00
    // EST, and a further hour of driving puts the pickup at 02:00 EST — both
    // after the change, so the doubled hour never gets counted twice.
    expect(plan.mustArriveAtLocal).toBe("2026-11-01T03:00");
    expect(plan.recommendedPickupLocal).toBe("2026-11-01T02:00");
  });

  it("handles the spring forward, when 2am to 3am does not exist", () => {
    // Clocks jump forward at 2am on 8 March 2026.
    const plan = planPickup({
      // The rule itself, without the cushion — see the block at the end.
      bufferMinutes: 0,
      requestedPickupLocal: null,
      flightDepartsLocal: "2026-03-08T07:00",
      flightKind: "DOMESTIC",
      driveMinutes: 45,
    });
    expect(plan.mustArriveAtLocal).toBe("2026-03-08T05:00");
    // 05:00 EDT − 45 min = 04:15 EDT.
    expect(plan.recommendedPickupLocal).toBe("2026-03-08T04:15");
  });
});

describe("planPickup — rounding", () => {
  it("rounds the pickup down to the nearest 5 minutes, never later", () => {
    const plan = planPickup({
      // The rule itself, without the cushion — see the block at the end.
      bufferMinutes: 0,
      requestedPickupLocal: null,
      flightDepartsLocal: "2026-09-22T14:00",
      flightKind: "DOMESTIC",
      driveMinutes: 53,
    });
    // 12:00 − 53 min = 11:07 → rounds down to 11:05.
    expect(plan.recommendedPickupLocal).toBe("2026-09-22T11:05");
  });
});

describe("describeLocal", () => {
  it("renders a time the way it should read in an email", () => {
    expect(describeLocal("2026-09-22T05:40")).toBe("Tuesday 22 September, 5:40 AM");
  });

  it("returns nothing for nothing", () => {
    expect(describeLocal(null)).toBeNull();
    expect(describeLocal("not a time")).toBeNull();
  });
});

describe("when only domestic-or-international is missing", () => {
  // Ticket #67: 1 Kalisa Way, Paramus to LGA, flight departs 5:45pm, and the
  // customer never said which kind of flight. Everything else was known, and
  // the plan answered with nothing — which left the reservation form blank
  // and a car booked for 7:48am against an evening flight.
  const departure = {
    requestedPickupLocal: null,
    flightDepartsLocal: "2026-08-28T17:45",
    flightKind: null,
    driveMinutes: 40,
    bufferMinutes: 0,
  };

  it("offers both answers instead of neither", () => {
    const plan = planPickup(departure);
    // 5:45pm − 2h at the airport − 40 min drive = 3:05pm.
    expect(plan.ifDomesticLocal).toBe("2026-08-28T15:05");
    // An hour earlier for the three-hour rule.
    expect(plan.ifInternationalLocal).toBe("2026-08-28T14:05");
  });

  it("still recommends nothing, because we still do not know", () => {
    // The two are an offer to the customer, not a decision. Filling
    // `recommendedPickupLocal` would state one of them as fact.
    const plan = planPickup(departure);
    expect(plan.recommendedPickupLocal).toBeNull();
    expect(plan.missing).toContain("whether the flight is domestic or international");
  });

  it("offers nothing when the drive is unknown", () => {
    // Two answers need the drive as much as one does. Guessing it here would
    // be the invented fact this file exists to avoid.
    const plan = planPickup({ ...departure, driveMinutes: null });
    expect(plan.ifDomesticLocal).toBeNull();
    expect(plan.ifInternationalLocal).toBeNull();
  });

  it("offers nothing when the flight time is unknown", () => {
    const plan = planPickup({ ...departure, flightDepartsLocal: null });
    expect(plan.ifDomesticLocal).toBeNull();
    expect(plan.ifInternationalLocal).toBeNull();
  });

  it("says nothing once the choice is settled", () => {
    const plan = planPickup({ ...departure, flightKind: "DOMESTIC" });
    expect(plan.recommendedPickupLocal).toBe("2026-08-28T15:05");
    expect(plan.ifDomesticLocal).toBeNull();
    expect(plan.ifInternationalLocal).toBeNull();
  });

  it("counts stops in both, the same way it counts them in one", () => {
    const plan = planPickup({ ...departure, stopDurationsMinutes: [null] });
    // The unstated stop costs 15 minutes off each.
    expect(plan.ifDomesticLocal).toBe("2026-08-28T14:50");
    expect(plan.ifInternationalLocal).toBe("2026-08-28T13:50");
  });

  it("agrees with the one-rule answer it would give if told", () => {
    // The two paths compute the same thing; a divergence would mean the
    // customer was quoted one time and the booking made at another.
    const both = planPickup(departure);
    for (const kind of ["DOMESTIC", "INTERNATIONAL"] as const) {
      const settled = planPickup({ ...departure, flightKind: kind });
      const offered = kind === "DOMESTIC" ? both.ifDomesticLocal : both.ifInternationalLocal;
      expect(offered).toBe(settled.recommendedPickupLocal);
    }
  });
});

describe("the traffic cushion", () => {
  // Newark, 25 August. The flight left at 4:20 PM, domestic check-in closed at
  // 2:20 PM, Google said 16 minutes, and the pickup came out at 2:00 PM — four
  // minutes of slack, and only because the time rounds down to five. Google's
  // number is one estimate of one journey on one day.
  const newark = {
    requestedPickupLocal: null,
    flightDepartsLocal: "2026-09-12T16:20",
    flightKind: "DOMESTIC" as const,
    driveMinutes: 16,
  };

  it("leaves earlier than the bare arithmetic, by default", () => {
    expect(planPickup({ ...newark, bufferMinutes: 0 }).recommendedPickupLocal).toBe(
      "2026-09-12T14:00"
    );
    // 2:20 PM − 16 min drive − 15 min cushion = 1:49, rounded down to 1:45.
    expect(planPickup(newark).recommendedPickupLocal).toBe("2026-09-12T13:45");
  });

  it("does not move the check-in deadline, which is the airport's rule", () => {
    // The cushion is ours. What the airport asks for is unchanged, and the
    // draft explains the two separately.
    expect(planPickup(newark).mustArriveAtLocal).toBe("2026-09-12T14:20");
    expect(planPickup(newark).leadMinutes).toBe(120);
  });

  it("applies to both answers when the flight kind is still open", () => {
    const open = planPickup({ ...newark, flightKind: null });
    expect(open.ifDomesticLocal).toBe("2026-09-12T13:45");
    expect(open.ifInternationalLocal).toBe("2026-09-12T12:45");
  });

  it("counts a customer's requested time as too late against the cushion too", () => {
    // Asking for 2:00 PM used to be exactly on time. It is now fifteen minutes
    // tighter than we are willing to run, and the draft has to say so.
    const plan = planPickup({ ...newark, requestedPickupLocal: "2026-09-12T14:00" });
    expect(plan.requestedIsTooLate).toBe(true);
    expect(plan.shortfallMinutes).toBe(15);
  });
});

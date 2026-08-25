import { describe, it, expect } from "vitest";
import { DateTime } from "luxon";
import { bookingUpdateFrom, type BookingNow } from "../booking-update";
import { OPERATING_TIME_ZONE } from "../pickup-time";

const at = (iso: string) => DateTime.fromISO(iso, { zone: OPERATING_TIME_ZONE }).toJSDate();

// Ticket #73, as it actually stood. A 5:45 PM departure, LGA, timed as
// international because nobody had said which it was.
function booking(over: Partial<BookingNow> = {}): BookingNow {
  return {
    pickupAt: at("2026-09-03T13:55"),
    flightAt: at("2026-09-03T17:45"),
    flightKind: null,
    flightNumber: null,
    passengerPhone: null,
    passengerCount: 1,
    luggageCount: 2,
    status: "SCHEDULED",
    ...over,
  };
}

const localOf = (d: Date) =>
  DateTime.fromJSDate(d).setZone(OPERATING_TIME_ZONE).toFormat("yyyy-MM-dd HH:mm");

describe("what a reply does to a booking that already exists", () => {
  it("leaves the pickup alone when the customer confirms what we assumed", () => {
    // 1:55 PM already was the international time. Confirming it must not
    // shuffle the car by a minute.
    const update = bookingUpdateFrom(booking(), { flightKind: "INTERNATIONAL" });

    expect(update.patch.flightKind).toBe("INTERNATIONAL");
    expect(update.patch.pickupAt).toBeUndefined();
  });

  it("moves the pickup an hour later when the flight turns out to be domestic", () => {
    const update = bookingUpdateFrom(booking(), { flightKind: "DOMESTIC" });

    expect(localOf(update.patch.pickupAt!)).toBe("2026-09-03 14:55");
    expect(update.said.join(" ")).toContain("Pickup moved");
  });

  it("moves the pickup an hour earlier when domestic is corrected to international", () => {
    // The one that costs somebody their flight. A 2:55 PM pickup booked
    // against a domestic reading has to come back to 1:55 PM.
    const update = bookingUpdateFrom(
      booking({ pickupAt: at("2026-09-03T14:55"), flightKind: "DOMESTIC" }),
      { flightKind: "INTERNATIONAL" }
    );

    expect(localOf(update.patch.pickupAt!)).toBe("2026-09-03 13:55");
  });

  it("keeps the drive time when the flight itself moves", () => {
    // 1h50m sits between the 2:45 PM check-in deadline and the 1:55 PM pickup
    // — drive, stop allowance and buffer. A flight two hours later should
    // move the pickup two hours later and nothing else.
    const update = bookingUpdateFrom(booking(), { flightTimeLocal: "2026-09-03T19:45" });

    expect(localOf(update.patch.pickupAt!)).toBe("2026-09-03 15:55");
  });

  it("records a flight on a booking that had none, but will not invent a pickup", () => {
    const update = bookingUpdateFrom(booking({ flightAt: null }), {
      flightTimeLocal: "2026-09-03T17:45",
      flightKind: "INTERNATIONAL",
    });

    expect(update.patch.flightAt).toBeDefined();
    expect(update.patch.pickupAt).toBeUndefined();
    expect(update.needsAPerson.join(" ")).toContain("no drive time");
  });

  it("takes the phone number and the flight number", () => {
    const update = bookingUpdateFrom(booking(), {
      passengerPhone: "201-555-0134",
      flightNumber: "BA178",
    });

    expect(update.patch.passengerPhone).toBe("201-555-0134");
    expect(update.patch.flightNumber).toBe("BA178");
    expect(update.patch.pickupAt).toBeUndefined();
  });

  it("asks a person to check the car when the party grows", () => {
    const update = bookingUpdateFrom(booking(), { passengerCount: 5 });

    expect(update.patch.passengerCount).toBe(5);
    expect(update.needsAPerson.join(" ")).toContain("big enough");
  });

  it("does nothing at all when the reply repeats what we already hold", () => {
    const update = bookingUpdateFrom(
      booking({ flightKind: "INTERNATIONAL", passengerPhone: "201-555-0134" }),
      { flightKind: "INTERNATIONAL", passengerPhone: "201-555-0134", passengerCount: 1 }
    );

    expect(update.patch).toEqual({});
    expect(update.said).toEqual([]);
  });

  it("will not rewrite a job that has already run", () => {
    const update = bookingUpdateFrom(booking({ status: "COMPLETED" }), {
      flightKind: "DOMESTIC",
    });

    expect(update.patch).toEqual({});
  });

  it("survives a flight time it cannot read", () => {
    const update = bookingUpdateFrom(booking(), { flightTimeLocal: "next tuesday-ish" });

    expect(update.patch).toEqual({});
  });
});

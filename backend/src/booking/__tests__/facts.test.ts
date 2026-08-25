import { describe, it, expect } from "vitest";
import { mergeFacts, describeFactChanges } from "../facts";
import type { DraftFacts } from "../../db/schema";

/** What the first email established on ticket #72. */
const first: DraftFacts = {
  passengerName: "Apurva",
  passengerPhone: null,
  bookerName: "Apurva",
  bookerEmail: "apupatel@gmail.com",
  pickupAddress: "1 Kalisa Way, Paramus, NJ 07652",
  dropoffAddress: "LaGuardia Airport (LGA), East Elmhurst, NY 11371",
  stops: [],
  pickupAtLocal: "2026-09-03T14:00",
  vehicleClass: "SEDAN",
  passengerCount: 1,
  luggageCount: 2,
  flightNumber: null,
  flightTimeLocal: "2026-09-03T17:45",
  flightKind: null,
};

describe("mergeFacts", () => {
  it("adds what the reply established", () => {
    // "my contact number 9978615599 / the flight is international"
    const after = mergeFacts(first, {
      passengerPhone: "9978615599",
      flightKind: "INTERNATIONAL",
    });
    expect(after.passengerPhone).toBe("9978615599");
    expect(after.flightKind).toBe("INTERNATIONAL");
  });

  it("never erases a fact the reply is simply silent about", () => {
    // This is the whole risk. A customer confirming their flight number must
    // not wipe their own pickup address.
    const after = mergeFacts(first, { flightNumber: "BA112" });
    expect(after.pickupAddress).toBe("1 Kalisa Way, Paramus, NJ 07652");
    expect(after.passengerCount).toBe(1);
    expect(after.flightTimeLocal).toBe("2026-09-03T17:45");
  });

  it("treats an explicit null in the reply as silence, not as a deletion", () => {
    const after = mergeFacts(first, { pickupAddress: null, vehicleClass: null });
    expect(after.pickupAddress).toBe("1 Kalisa Way, Paramus, NJ 07652");
    expect(after.vehicleClass).toBe("SEDAN");
  });

  it("treats an empty string the same way", () => {
    // An extractor that finds nothing sometimes says "" rather than null.
    const after = mergeFacts(first, { passengerName: "   " });
    expect(after.passengerName).toBe("Apurva");
  });

  it("lets a later email correct an earlier one", () => {
    // "Actually make it four of us" has to win.
    const after = mergeFacts(first, { passengerCount: 4, vehicleClass: "SUV" });
    expect(after.passengerCount).toBe(4);
    expect(after.vehicleClass).toBe("SUV");
  });

  it("keeps a zero, which is a fact rather than an absence", () => {
    const after = mergeFacts({ ...first, luggageCount: 3 }, { luggageCount: 0 });
    expect(after.luggageCount).toBe(0);
  });

  it("replaces the stops wholesale or not at all", () => {
    // Half a route from each of two emails is a journey nobody described.
    const withStops = mergeFacts(first, { stops: ["40 Wall Street"] });
    expect(withStops.stops).toEqual(["40 Wall Street"]);
    expect(mergeFacts(withStops, { stops: [] }).stops).toEqual(["40 Wall Street"]);
  });
});

describe("describeFactChanges", () => {
  it("names what a reply added, so it does not appear from nowhere", () => {
    const after = mergeFacts(first, { passengerPhone: "9978615599", flightKind: "INTERNATIONAL" });
    const changes = describeFactChanges(first, after);
    expect(changes).toContain("Passenger phone: 9978615599");
    expect(changes).toContain("Flight kind: INTERNATIONAL");
  });

  it("shows both sides when something was corrected", () => {
    const after = mergeFacts(first, { passengerCount: 4 });
    expect(describeFactChanges(first, after)).toContain("Passengers: 1 → 4");
  });

  it("says nothing when nothing moved", () => {
    expect(describeFactChanges(first, mergeFacts(first, {}))).toEqual([]);
  });
});

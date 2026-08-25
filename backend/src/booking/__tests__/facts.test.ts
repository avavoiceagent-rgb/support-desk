import { describe, it, expect } from "vitest";
import { mergeFacts, describeFactChanges, bookerNameFromReply } from "../facts";
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

describe("the time a customer names in their answer", () => {
  // Adam asks when they would like to be collected, they say — and until this
  // the answer went into the conversation and nowhere else, so the
  // reservation form still opened with an empty date box. That blank is the
  // one that once let a browser fill it with the current time.
  const empty = {
    passengerName: null,
    passengerPhone: null,
    bookerName: null,
    bookerEmail: null,
    pickupAddress: null,
    dropoffAddress: null,
    stops: [],
    pickupAtLocal: null,
    vehicleClass: null,
    passengerCount: null,
    luggageCount: null,
    flightNumber: null,
  };

  it("lands on the facts the form is filled from", () => {
    const after = mergeFacts(empty, { pickupAtLocal: "2026-11-14T18:05" });
    expect(after.pickupAtLocal).toBe("2026-11-14T18:05");
  });

  it("corrects one already there", () => {
    const after = mergeFacts(
      { ...empty, pickupAtLocal: "2026-11-14T18:05" },
      { pickupAtLocal: "2026-11-14T19:30" }
    );
    expect(after.pickupAtLocal).toBe("2026-11-14T19:30");
  });

  it("is not erased by a reply that says nothing about it", () => {
    // The rule the whole file exists for: silence never wipes.
    const after = mergeFacts(
      { ...empty, pickupAtLocal: "2026-11-14T18:05" },
      { passengerPhone: "201-555-0134" }
    );
    expect(after.pickupAtLocal).toBe("2026-11-14T18:05");
  });

  it("shows up in what changed, so it does not appear from nowhere", () => {
    const before = { ...empty };
    const after = mergeFacts(before, { pickupAtLocal: "2026-11-14T18:05" });
    expect(describeFactChanges(before, after).join(" ")).toContain("Pickup time");
  });
});

describe("the booker name a reply is allowed to contribute", () => {
  // Watched happen on the live desk, twice. The first draft on #86 read
  // "Booker: Priya Raman" — correct, off the sign-off. Then a reply saying
  // only "my number is 9978615599" arrived, the extractor did what its prompt
  // tells it to do with an unsigned message and named the mailbox owner, and
  // the merge wrote Amar Pant over her. Adam's own note recorded it:
  // "Booker: Priya Raman → Amar Pant".

  it("does not replace a name the customer already signed with", async () => {
    expect(bookerNameFromReply("Priya Raman", "Amar Pant")).toBeNull();
  });

  it("does not replace it even with the same name back", async () => {
    // Nothing to say is better than a no-op write; a fact that did not move
    // should not appear in "what changed".
    expect(bookerNameFromReply("Priya Raman", "Priya Raman")).toBeNull();
  });

  it("fills a blank, which is the case it is useful for", async () => {
    expect(bookerNameFromReply(null, "Priya Raman")).toBe("Priya Raman");
  });

  it("treats whitespace as a blank on both sides", async () => {
    expect(bookerNameFromReply("   ", "Priya Raman")).toBe("Priya Raman");
    expect(bookerNameFromReply(null, "   ")).toBeNull();
  });

  it("has nothing to add when the reply named nobody", async () => {
    expect(bookerNameFromReply(null, null)).toBeNull();
  });
});

describe("mergeFacts leaves the booker alone when handed nothing", () => {
  it("keeps the established name", async () => {
    // The pairing that matters: the guard returns null, and null is silence.
    const after = mergeFacts(first, {
      passengerPhone: "9978615599",
      bookerName: bookerNameFromReply(first.bookerName, "Amar Pant"),
    });
    expect(after.bookerName).toBe("Apurva");
    expect(after.passengerPhone).toBe("9978615599");
    expect(describeFactChanges(first, after)).toEqual(["Passenger phone: 9978615599"]);
  });
});

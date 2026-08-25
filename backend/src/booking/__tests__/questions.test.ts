import { describe, it, expect } from "vitest";
import { reviewBooking, type ReviewInput } from "../questions";
import { EMPTY_BOOKING, type ExtractedBooking } from "../extract";
import type { VerifiedAddress } from "../maps";
import { planPickup } from "../pickup-time";

const verified = (over: Partial<VerifiedAddress> = {}): VerifiedAddress => ({
  formattedAddress: "245 Park Ave, New York, NY 10167, USA",
  postalCode: "10167",
  placeId: "p1",
  isAirport: false,
  state: "NY",
  partialMatch: false,
  query: "245 park ave",
  lat: 40.7554,
  lng: -73.9757,
  ...over,
});

const jfk = verified({
  formattedAddress: "John F. Kennedy International Airport, Queens, NY 11430, USA",
  isAirport: true,
  placeId: "jfk",
  query: "JFK",
});

function review(booking: Partial<ExtractedBooking>, over: Partial<ReviewInput> = {}) {
  const full: ExtractedBooking = { ...EMPTY_BOOKING, ...booking };
  return reviewBooking({
    booking: full,
    pickup: verified(),
    dropoff: jfk,
    stops: [],
    plan: planPickup({
      requestedPickupLocal: full.requestedPickupLocal,
      flightDepartsLocal: full.flightTimeLocal,
      flightKind: full.flightKind,
      driveMinutes: 50,
    }),
    isExternal: false,
    senderEmail: "booker@customer.example",
    ...over,
  });
}

const asks = (r: { questions: string[] }, fragment: string) =>
  r.questions.some((q) => q.toLowerCase().includes(fragment.toLowerCase()));

const confirms = (r: { confirmations: string[] }, fragment: string) =>
  r.confirmations.some((c) => c.toLowerCase().includes(fragment.toLowerCase()));

describe("who is travelling", () => {
  it("asks when the email never says whether the booker is the passenger", () => {
    const r = review({ bookerName: "Daniel Weiss" });
    expect(asks(r, "travelling yourself")).toBe(true);
    expect(confirms(r, "Booker: Daniel Weiss")).toBe(true);
  });

  it("does not ask when the email counted the booker in", () => {
    // "Two of us, two suitcases" — he told us, so asking again is a mistake.
    const r = review({ bookerName: "Daniel Weiss", bookerIsPassenger: true, passengerCount: 2 });
    expect(asks(r, "travelling yourself")).toBe(false);
    expect(confirms(r, "Daniel Weiss, travelling with 1 other")).toBe(true);
  });

  it("pluralises when the booker travels with more than one other", () => {
    const r = review({ bookerName: "Daniel Weiss", bookerIsPassenger: true, passengerCount: 4 });
    expect(confirms(r, "travelling with 3 others")).toBe(true);
  });

  it("does not ask when the booker said they are travelling themselves", () => {
    const r = review({ bookerName: "Daniel Weiss", bookerIsPassenger: true });
    expect(asks(r, "travelling yourself")).toBe(false);
    expect(confirms(r, "travelling yourself")).toBe(true);
  });

  it("asks for the passenger's name when booking for someone else without naming them", () => {
    const r = review({ bookerName: "Daniel Weiss", bookerIsPassenger: false });
    expect(asks(r, "passenger's name")).toBe(true);
  });

  it("confirms both names when booking for a named someone else", () => {
    const r = review({ bookerName: "Daniel Weiss", bookerIsPassenger: false, passengerName: "Ana Costa" });
    expect(confirms(r, "Booker: Daniel Weiss")).toBe(true);
    expect(confirms(r, "Passenger: Ana Costa")).toBe(true);
    expect(asks(r, "passenger's name")).toBe(false);
  });
});

describe("contact numbers", () => {
  it("does not confirm the sender's own address back to them", () => {
    // It used to. Beside the contact-number question it produced "is this
    // email also the best number to reach you" on two live tickets, and two
    // attempts to make a model stop writing that failed. See questions.ts.
    expect(confirms(review({}), "booker@customer.example")).toBe(false);
  });

  it("asks for a number when the email has none", () => {
    // Worded as a mobile the driver needs, not an abstract "contact number" —
    // see the ticket #67 note in questions.ts.
    expect(asks(review({ bookerIsPassenger: true }), "mobile number for the day")).toBe(true);
  });

  it("asks the customer to confirm a number found in the signature", () => {
    const r = review({ bookerIsPassenger: true, bookerPhone: "+1 917 555 0134" });
    expect(confirms(r, "917 555 0134")).toBe(true);
    expect(confirms(r, "best number")).toBe(true);
  });

  it("asks for the passenger's number when booking for someone else", () => {
    const r = review({ bookerIsPassenger: false, passengerName: "Ana", bookerPhone: "+1 917 555 0134" });
    expect(asks(r, "mobile number for the passenger")).toBe(true);
  });

  it("does not ask when the booker said to use their own number", () => {
    const r = review({
      bookerIsPassenger: false,
      passengerName: "Ana",
      bookerPhone: "+1 917 555 0134",
      useBookerPhoneForPassenger: true,
    });
    expect(asks(r, "mobile number for the passenger")).toBe(false);
    expect(confirms(r, "use your number")).toBe(true);
  });
});

describe("addresses", () => {
  it("states a verified address with its postcode and asks nothing", () => {
    const r = review({ pickupAddressText: "245 park ave" });
    expect(confirms(r, "10167")).toBe(true);
    expect(asks(r, "pickup address")).toBe(false);
  });

  it("asks the customer to confirm an address Google was unsure about", () => {
    const r = review({ pickupAddressText: "park ave" }, { pickup: verified({ partialMatch: true }) });
    expect(confirms(r, "confirm this is right")).toBe(true);
  });

  it("quotes an unverifiable address back and asks, rather than inventing one", () => {
    const r = review({ pickupAddressText: "the blue house on the corner" }, { pickup: null });
    expect(confirms(r, "the blue house on the corner")).toBe(true);
    expect(confirms(r, "confirm the full address")).toBe(true);
  });

  it("does not ask for a postcode on an airport", () => {
    const r = review({ dropoffAddressText: "JFK" });
    const dropoffLine = r.confirmations.find((c) => c.startsWith("Drop-off"));
    // No postcode question, and no ", USA" trailing off the end of it.
    expect(dropoffLine).toBe("Drop-off: John F. Kennedy International Airport, Queens, NY 11430");
  });

  it("asks for a missing address", () => {
    const r = review({}, { dropoff: null });
    expect(asks(r, "drop-off address")).toBe(true);
  });
});

describe("flights", () => {
  it("asks for the departure time and whether it is domestic on an airport run", () => {
    const r = review({ flightDirection: "DEPARTURE" });
    expect(asks(r, "flight departure time")).toBe(true);
    expect(asks(r, "domestic or international")).toBe(true);
    expect(asks(r, "flight number")).toBe(true);
  });

  it("stops asking once the email gave the details", () => {
    const r = review({
      flightDirection: "DEPARTURE",
      flightTimeLocal: "2026-09-22T18:00",
      flightKind: "INTERNATIONAL",
      flightNumber: "BA112",
    });
    expect(asks(r, "flight departure time")).toBe(false);
    expect(asks(r, "domestic or international")).toBe(false);
    expect(asks(r, "flight number")).toBe(false);
  });

  it("asks for the flight number on an arrival so the driver can track it", () => {
    const r = review({ flightDirection: "ARRIVAL" }, { dropoff: verified() });
    expect(asks(r, "flight number")).toBe(true);
  });
});

describe("vehicle", () => {
  it("confirms the vehicle when the customer asked for one, and does not ask about numbers", () => {
    const r = review({ vehicleRequested: "SUV" });
    expect(r.vehicleSuggestion).toBe("SUV");
    expect(asks(r, "how many passengers")).toBe(false);
  });

  it("recommends a sedan for a small party", () => {
    expect(review({ passengerCount: 2, luggageCount: 2 }).vehicleSuggestion).toBe("Sedan");
  });

  it("recommends an SUV when the party is too big for a sedan", () => {
    expect(review({ passengerCount: 5, luggageCount: 2 }).vehicleSuggestion).toBe("SUV");
    expect(review({ passengerCount: 2, luggageCount: 5 }).vehicleSuggestion).toBe("SUV");
  });

  it("asks, quoting both capacities, when nothing is known", () => {
    const r = review({});
    expect(asks(r, "a sedan takes up to 3 passengers and 3 bags")).toBe(true);
    expect(asks(r, "an SUV up to 6 and 6")).toBe(true);
  });
});

describe("notes for the person reviewing", () => {
  it("warns that an external trip must not be promised", () => {
    const r = review({}, { isExternal: true });
    expect(r.internalNotes.join(" ")).toContain("covered by a partner");
  });

  it("spells out a pickup time that would make the passenger late", () => {
    const r = review({
      flightDirection: "DEPARTURE",
      flightTimeLocal: "2026-09-22T18:00",
      flightKind: "INTERNATIONAL",
      requestedPickupLocal: "2026-09-22T15:00",
    });
    // 18:00 flight − 3h international rule = 15:00 at the airport, − the
    // 50-minute drive this helper uses − the 15-minute traffic cushion = a
    // 13:55 pickup, so the 15:00 they asked for is 65 minutes too late.
    expect(r.internalNotes.join(" ")).toContain("65 minutes too late");
    // Spelled out for the dispatcher reading it, not the raw "2026-09-22T13:55".
    expect(r.internalNotes.join(" ")).toContain("Tuesday 22 September, 1:55 PM");
    expect(r.internalNotes.join(" ")).not.toContain("2026-09-22T13:55");
  });

  it("flags a stop with no stated duration", () => {
    const r = review(
      { stops: [{ addressText: "40 Wall St", durationMinutes: null }] },
      { stops: [verified({ formattedAddress: "40 Wall St, New York, NY 10005, USA" })] }
    );
    expect(r.internalNotes.join(" ")).toContain("15 minutes allowed");
  });

  it("says when an address could not be checked on the map", () => {
    const r = review({ pickupAddressText: "the blue house" }, { pickup: null });
    expect(r.internalNotes.join(" ")).toContain("Could not verify the pickup address");
  });
});

describe("a departure with the flight kind still open", () => {
  // Ticket #67, in the shape the desk actually received it: date and flight
  // time given, domestic-or-international not.
  const apurva = { flightTimeLocal: "2026-08-28T17:45", flightDirection: "DEPARTURE" as const };

  it("does not ask for a time it can already work out", () => {
    // The old draft asked "the date and time you'd like to be collected" of a
    // customer who had given the date and the flight time. Both answers were
    // computable; only the choice between them was not.
    const r = review(apurva);
    expect(asks(r, "date and time you'd like to be collected")).toBe(false);
    expect(asks(r, "time you'd like to be collected")).toBe(false);
  });

  it("asks the one open question, with what each answer would mean", () => {
    const r = review(apurva);
    const question = r.questions.find((q) => q.includes("domestic or international"));
    expect(question).toBeDefined();
    // 5:45pm − 2h − 50 min drive − 15 min cushion, and an hour earlier again
    // for international.
    expect(question).toContain("2:40 PM");
    expect(question).toContain("1:40 PM");
  });

  it("tells the desk which of the two the booking has been set to", () => {
    const r = review(apurva);
    const note = r.internalNotes.find((n) => n.includes("Flight kind not stated"));
    expect(note).toBeDefined();
    // The earlier one, so an unanswered email cannot make somebody late.
    expect(note).toContain("1:40 PM");
    expect(note).toContain("2:40 PM");
  });

  it("still asks for the date when there is no flight time either", () => {
    const r = review({ flightDirection: "DEPARTURE" });
    expect(asks(r, "date and time you'd like to be collected")).toBe(true);
  });

  it("asks only for the time when the flight time gives the date", () => {
    // No drive measured, so neither answer is computable — but the day is
    // still settled by the flight, and asking for it again reads as though
    // nobody had opened the email.
    const r = review(apurva, {
      plan: planPickup({
        requestedPickupLocal: null,
        flightDepartsLocal: "2026-08-28T17:45",
        flightKind: null,
        driveMinutes: null,
      }),
    });
    expect(asks(r, "the time you'd like to be collected")).toBe(true);
    expect(asks(r, "date and time")).toBe(false);
  });

  it("goes back to the plain question once the kind is known", () => {
    const r = review({ ...apurva, flightKind: "DOMESTIC" });
    expect(asks(r, "domestic or international")).toBe(false);
    expect(r.internalNotes.some((n) => n.includes("Flight kind not stated"))).toBe(false);
  });
});

describe("the contact question cannot be mistaken for the email line", () => {
  it("asks for a mobile in words that name a phone and a driver", () => {
    // Ticket #67: the composer merged the email confirmation and the contact
    // question into "is this also the best contact number to reach you",
    // about an email address. The prompt already banned that sentence; this
    // makes the two items too different in kind to glue together.
    const r = review({});
    const question = r.questions.find((q) => q.includes("mobile number for the day"));
    expect(question).toBeDefined();
    expect(question).toContain("driver");
    // And the line it kept being welded to is gone: the sender's own address,
    // confirmed back to them in an email they are reading at that address.
    expect(confirms(r, "email for updates")).toBe(false);
    expect(r.confirmations.some((c) => c.includes("@"))).toBe(false);
  });

  it("does not ask at all when a number was given", () => {
    const r = review({ bookerPhone: "201-693-4150" });
    expect(asks(r, "mobile number for the day")).toBe(false);
    expect(confirms(r, "201-693-4150")).toBe(true);
  });
});

describe("the unsure-address note", () => {
  const unsureJfk = verified({ ...jfk, partialMatch: true });

  it("names the place, not 'one of the addresses'", () => {
    const r = review({}, { pickup: verified({ partialMatch: true }) });
    const note = r.internalNotes.find((n) => n.includes("wasn't certain"));
    expect(note).toContain("pickup");
    expect(note).toContain("245 Park Ave");
  });

  it("does not claim an ask the draft never makes for an airport", () => {
    // Tickets #67 and #72: LaGuardia was the unsure address, the draft
    // correctly said nothing, and the note announced a question that was not
    // in the email.
    const r = review({}, { dropoff: unsureJfk });
    const note = r.internalNotes.find((n) => n.includes("wasn't certain"));
    expect(note).toContain("it is an airport");
    expect(note).not.toContain("asks the customer to confirm");
    // And the draft really does leave the airport line alone.
    expect(r.confirmations.some((c) => c.includes("Kennedy") && c.includes("confirm"))).toBe(false);
  });

  it("warns about both ends when both are unsure", () => {
    const r = review({}, { pickup: verified({ partialMatch: true }), dropoff: unsureJfk });
    expect(r.internalNotes.filter((n) => n.includes("wasn't certain"))).toHaveLength(2);
  });

  it("says nothing when Google was sure", () => {
    const r = review({});
    expect(r.internalNotes.some((n) => n.includes("wasn't certain"))).toBe(false);
  });
});

describe("the flight is read back to the customer", () => {
  it("confirms the departure time it understood", () => {
    // Apurva wrote "545pm". Everything else on the booking is derived from
    // how that was read, so it is worth one line to let him catch it.
    const r = review({ flightTimeLocal: "2026-09-03T17:45", flightDirection: "DEPARTURE" });
    expect(confirms(r, "flight departs")).toBe(true);
    expect(confirms(r, "5:45 PM")).toBe(true);
  });

  it("includes the number and the kind once they are known", () => {
    const r = review({
      flightTimeLocal: "2026-09-03T17:45",
      flightDirection: "DEPARTURE",
      flightNumber: "BA112",
      flightKind: "INTERNATIONAL",
    });
    expect(confirms(r, "BA112")).toBe(true);
    expect(confirms(r, "international")).toBe(true);
  });

  it("says lands, not departs, for an arrival", () => {
    const r = review({ flightTimeLocal: "2026-09-03T09:20", flightDirection: "ARRIVAL" });
    expect(confirms(r, "flight lands")).toBe(true);
  });

  it("says nothing when no flight time was given", () => {
    expect(confirms(review({}), "flight departs")).toBe(false);
  });
});

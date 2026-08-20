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
  it("always confirms the sender's email as the contact address", () => {
    expect(confirms(review({}), "booker@customer.example")).toBe(true);
  });

  it("asks for a number when the email has none", () => {
    expect(asks(review({ bookerIsPassenger: true }), "contact number")).toBe(true);
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
    expect(dropoffLine).toBe("Drop-off: John F. Kennedy International Airport, Queens, NY 11430, USA");
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
    // 50-minute drive this helper uses = a 14:10 pickup, so the 15:00 they
    // asked for is 50 minutes too late.
    expect(r.internalNotes.join(" ")).toContain("50 minutes too late");
    expect(r.internalNotes.join(" ")).toContain("2026-09-22T14:10");
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

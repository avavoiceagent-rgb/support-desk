import { describe, it, expect } from "vitest";
import {
  CAPACITY,
  vehicleClassFor,
  vehicleClassForLoad,
  vehicleClassFromText,
} from "../vehicles";

describe("vehicleClassFromText", () => {
  it("reads the plain words", () => {
    expect(vehicleClassFromText("Sedan")).toBe("SEDAN");
    expect(vehicleClassFromText("a large SUV please")).toBe("SUV");
    expect(vehicleClassFromText("minivan")).toBe("VAN");
    expect(vehicleClassFromText("town car")).toBe("SEDAN");
  });

  it("prefers Sprinter over van when both appear", () => {
    // "Executive Sprinter van" is a Sprinter. Reading it as a van would send
    // a seven-seater to collect twelve people.
    expect(vehicleClassFromText("executive sprinter van")).toBe("SPRINTER");
  });

  it("refuses to guess at something that is not a class", () => {
    // "Something comfortable" defaulted to a sedan would quietly commit us to
    // the cheapest car for a customer who may have meant the largest.
    expect(vehicleClassFromText("something comfortable")).toBeNull();
    expect(vehicleClassFromText(null)).toBeNull();
    expect(vehicleClassFromText("")).toBeNull();
  });
});

describe("vehicleClassForLoad", () => {
  it("picks the smallest car the party actually fits in", () => {
    expect(vehicleClassForLoad(2, 2)).toBe("SEDAN");
    expect(vehicleClassForLoad(3, 3)).toBe("SEDAN");
    expect(vehicleClassForLoad(4, 2)).toBe("SUV");
    expect(vehicleClassForLoad(7, 4)).toBe("VAN");
    expect(vehicleClassForLoad(9, 9)).toBe("SPRINTER");
  });

  it("sizes up for luggage even when the party is small", () => {
    // Two people and eight suitcases is a van job. Counting only heads books a
    // sedan and leaves half the bags on the kerb.
    expect(vehicleClassForLoad(2, 8)).toBe("SPRINTER");
    expect(vehicleClassForLoad(2, 5)).toBe("SUV");
  });

  it("does not read a missing count as zero", () => {
    // Four suitcases and nothing said about passengers still needs a boot.
    expect(vehicleClassForLoad(null, 4)).toBe("SUV");
    expect(vehicleClassForLoad(5, null)).toBe("SUV");
    // Neither number known is not "nobody is travelling" — it is not knowing.
    expect(vehicleClassForLoad(null, null)).toBeNull();
    expect(vehicleClassForLoad(undefined, undefined)).toBeNull();
  });

  it("says nothing rather than offering the biggest car we have", () => {
    // More people than a Sprinter holds is a coach booking. Answering
    // SPRINTER would look like a car had been found for them.
    expect(vehicleClassForLoad(20, 0)).toBeNull();
    expect(vehicleClassForLoad(2, 40)).toBeNull();
  });

  it("agrees with the capacities Adam quotes to customers", () => {
    // The prose in questions.ts and the arithmetic here read the same table,
    // so a car Adam describes as fitting three really does take three.
    expect(vehicleClassForLoad(CAPACITY.SEDAN.passengers, CAPACITY.SEDAN.bags)).toBe("SEDAN");
    expect(vehicleClassForLoad(CAPACITY.SEDAN.passengers + 1, 0)).toBe("SUV");
    expect(vehicleClassForLoad(CAPACITY.SUV.passengers + 1, 0)).toBe("VAN");
  });
});

describe("vehicleClassFor", () => {
  it("takes the class from the numbers, not the prose", () => {
    // This is the bug the regex used to have: five people asking for "a car"
    // came out as whatever word matched first, or as nothing at all.
    expect(vehicleClassFor({ passengerCount: 5, luggageCount: 5, requested: "a car" })).toBe("SUV");
  });

  it("honours a bigger car than the party needs", () => {
    // One passenger who asked for an SUV gets an SUV. They may be paying for
    // the space, and downgrading them is a complaint waiting to happen.
    expect(vehicleClassFor({ passengerCount: 1, luggageCount: 1, requested: "SUV please" })).toBe("SUV");
    expect(vehicleClassFor({ passengerCount: 2, luggageCount: 0, requested: "sprinter" })).toBe("SPRINTER");
  });

  it("never shrinks the car to match the words", () => {
    // Six people who wrote "sedan" do not get a sedan. The words are a floor,
    // never the answer.
    expect(vehicleClassFor({ passengerCount: 6, luggageCount: 6, requested: "sedan" })).toBe("SUV");
    expect(vehicleClassFor({ passengerCount: 8, luggageCount: 8, requested: "town car" })).toBe("SPRINTER");
  });

  it("still reads 'an SUV or a van' as the van, and that is the harmless way round", () => {
    // Someone who names two classes gets whichever the word list hits first,
    // which is the larger one. Left as it is on purpose: the customer said
    // either would do, so a van is a car they asked for. The direction that
    // would matter — resolving it as something too small for the party — is
    // what the counts now prevent.
    expect(vehicleClassFor({ passengerCount: 3, luggageCount: 2, requested: "an SUV or a van" })).toBe("VAN");
    expect(vehicleClassFor({ passengerCount: 7, luggageCount: 7, requested: "an SUV or a van" })).toBe("VAN");
  });

  it("falls back to the request when no counts were given", () => {
    expect(vehicleClassFor({ passengerCount: null, luggageCount: null, requested: "minivan" })).toBe("VAN");
  });

  it("returns null when the email said neither", () => {
    // Better an empty field a person can see than a sedan nobody chose.
    expect(vehicleClassFor({ passengerCount: null, luggageCount: null, requested: null })).toBeNull();
    expect(vehicleClassFor({})).toBeNull();
  });

  it("returns null when the party fits in no car at all, whatever they asked for", () => {
    // Thirty people who wrote "sprinter" still do not fit in a Sprinter.
    // Taking the word would stamp a class on a booking no one car can cover.
    expect(vehicleClassFor({ passengerCount: 30, luggageCount: 0, requested: "sprinter" })).toBeNull();
    expect(vehicleClassFor({ passengerCount: 2, luggageCount: 40, requested: "SUV" })).toBeNull();
  });
});

import { describe, it, expect } from "vitest";
import { extractReferences } from "../references";

// No database anywhere in this file — that is the point of keeping extraction
// pure. It is the half of the lookup story that guesses, so it gets the
// hardest tests in the ops area.

const body = (text: string) => extractReferences("", text);

describe("extractReferences", () => {
  it("reads a trip reference however it is written", () => {
    for (const typed of [
      "can we move T-10432 to 10am",
      "can we move t-10432 to 10am",
      "can we move t10432 to 10am",
      "can we move T 10432 to 10am",
      "can we move booking 10432 to 10am",
      "can we move trip 10432 to 10am",
      "can we move reservation 10432 to 10am",
      "can we move booking no. 10432 to 10am",
      "can we move booking #10432 to 10am",
    ]) {
      expect(body(typed).trips, `for ${JSON.stringify(typed)}`).toEqual(["T-10432"]);
    }
  });

  it("reads an invoice reference however it is written", () => {
    for (const typed of [
      "INV-10432 charges twice",
      "inv-10432 charges twice",
      "inv10432 charges twice",
      "INV 10432 charges twice",
      "invoice 10432 charges twice",
      "invoice no. 10432 charges twice",
      "bill 10432 charges twice",
    ]) {
      expect(body(typed).invoices, `for ${JSON.stringify(typed)}`).toEqual(["INV-10432"]);
    }
  });

  it("treats the same invoice written two ways as one invoice", () => {
    const found = body("invoice 10432 charges twice — see INV-10432 attached");
    expect(found.invoices).toEqual(["INV-10432"]);
  });

  it("treats the same trip written two ways as one trip", () => {
    expect(body("T-10432, booking 10432, and t10432 are all the same ride").trips)
      .toEqual(["T-10432"]);
  });

  it("keeps several distinct references, in the order they appear", () => {
    const found = body("Please cancel T-10500 and T-10432, and check invoice 10433 and INV-10001.");
    expect(found.trips).toEqual(["T-10500", "T-10432"]);
    expect(found.invoices).toEqual(["INV-10433", "INV-10001"]);
  });

  it("does not treat a bare number as a reference", () => {
    // The trap. An email about a ride is full of five-digit numbers, and none
    // of these is a booking.
    for (const text of [
      "10432",
      "my postcode is 07094",
      "drop at 350 5th Ave, New York NY 10118",
      "flight DL2801 lands at 18:40",
      "call me on 917 555 0142",
      "the fare came to 10432 cents",
      "we are 10432 miles from agreeing",
    ]) {
      const found = body(text);
      expect(found.trips, `for ${JSON.stringify(text)}`).toEqual([]);
      expect(found.invoices, `for ${JSON.stringify(text)}`).toEqual([]);
    }
  });

  it("does not read a date or a time as a reference", () => {
    expect(body("trip 22/09/2026 at Terminal 4")).toEqual({ trips: [], invoices: [] });
    expect(body("booking on 2026-09-22")).toEqual({ trips: [], invoices: [] });
  });

  it("never reads a bare #number as a reference, whatever its length", () => {
    // A hash says a number matters, not what kind of number it is — and this
    // project writes its own ticket numbers exactly that way. An earlier draft
    // read "#10432" as a trip with a four-digit floor, which was a collision
    // scheduled for the day ticket numbers reach four digits. This test exists
    // to stop that coming back.
    for (const text of [
      "see #60 for background",
      "see #1234 for background",
      "see #10432 for background",
      "please cancel #10432",
    ]) {
      expect(body(text), `for ${JSON.stringify(text)}`).toEqual({ trips: [], invoices: [] });
    }
  });

  it("still reads a hash when a word gives it meaning", () => {
    // The word carries the sense; the hash is punctuation between it and the
    // digits. Dropping the bare form must not break this one.
    expect(body("please cancel booking #10432").trips).toEqual(["T-10432"]);
    expect(body("please check invoice #10432").invoices).toEqual(["INV-10432"]);
    expect(body("trip no. #10432 was fine").trips).toEqual(["T-10432"]);
  });

  it("finds nothing in an email that mentions nothing", () => {
    expect(body("Hi, do you cover Newark airport on Sundays? Thanks, Ana")).toEqual({
      trips: [],
      invoices: [],
    });
    expect(extractReferences("", "")).toEqual({ trips: [], invoices: [] });
  });

  it("reads the subject as well as the body, subject first", () => {
    const found = extractReferences("Re: T-10500 — change of plan", "actually make it T-10432");
    expect(found.trips).toEqual(["T-10500", "T-10432"]);
  });

  it("does not mistake the word invoice or trip on its own for a reference", () => {
    expect(body("please send the invoice when you can")).toEqual({ trips: [], invoices: [] });
    expect(body("the trip was lovely, thank you")).toEqual({ trips: [], invoices: [] });
  });

  it("does not read a word ending in t as a trip prefix", () => {
    // "at 10432" and "Suite 10432" both put a t next to digits.
    expect(body("we land at 10432 feet")).toEqual({ trips: [], invoices: [] });
    expect(body("Suite 10432, 5th Avenue")).toEqual({ trips: [], invoices: [] });
  });

  it("keeps trips and invoices apart even when the number is the same", () => {
    const found = body("trip 10432 was fine but invoice 10432 charges twice");
    expect(found.trips).toEqual(["T-10432"]);
    expect(found.invoices).toEqual(["INV-10432"]);
  });
});

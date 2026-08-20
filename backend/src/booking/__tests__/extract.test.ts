import { describe, it, expect } from "vitest";
import { bookerTravelsFromText, parseExtraction, normalizeLocalTime } from "../extract";

describe("bookerTravelsFromText", () => {
  // The email that prompted this: Daniel wrote "Two of us, two suitcases" and
  // Adam still asked him whether he was travelling himself.
  it("counts the writer in when they count themselves in", () => {
    for (const text of [
      "I need a car on Monday 28 September.\nTwo of us, two suitcases.",
      "There will be four of us.",
      "Both of us have one bag each.",
      "My wife and I are going to the airport.",
      "Me and my colleague need a lift.",
      "Just me, one small case.",
      "A sedan for myself please.",
    ]) {
      expect(bookerTravelsFromText(text), text).toBe(true);
    }
  });

  it("counts the writer in when they ask to be carried", () => {
    for (const text of [
      "Please pick me up at 9am.",
      "Can you collect us from Terminal B?",
      "Drop us at 245 Park Avenue.",
      "Take me to JFK on Friday.",
    ]) {
      expect(bookerTravelsFromText(text), text).toBe(true);
    }
  });

  it("counts the writer in when they describe their own journey", () => {
    for (const text of [
      "I'm flying to London at 6pm.",
      "We are travelling on the 22nd.",
      "Our flight lands at 14:20.",
      "My flight departs at 18:00.",
    ]) {
      expect(bookerTravelsFromText(text), text).toBe(true);
    }
  });

  it("stays out of it when arranging a car is all the email says", () => {
    for (const text of [
      "I need a car on Monday 28 September to JFK Terminal 4.",
      "Could you send a sedan on Friday at 9am?",
      "Please quote for a transfer from Manhattan to Newark.",
      "There will be two passengers and three bags.",
      "",
    ]) {
      expect(bookerTravelsFromText(text), text).toBe(false);
    }
  });

  it("never infers over an email that names someone else as the traveller", () => {
    for (const text of [
      "I am booking on behalf of Mr Smith. Pick him up at 9am.",
      "A car for my client, two of us will meet him there.",
      "Booking for our guest, please collect us at reception.",
    ]) {
      expect(bookerTravelsFromText(text), text).toBe(false);
    }
  });
});

describe("parseExtraction", () => {
  it("leaves bookerIsPassenger unset when the model omits it", () => {
    expect(parseExtraction({ bookerName: "Daniel Weiss" }).bookerIsPassenger).toBeNull();
  });

  it("keeps a stated answer either way", () => {
    expect(parseExtraction({ bookerIsPassenger: true }).bookerIsPassenger).toBe(true);
    expect(parseExtraction({ bookerIsPassenger: false }).bookerIsPassenger).toBe(false);
  });

  it("drops junk rather than passing it on", () => {
    expect(parseExtraction(null).bookerName).toBeNull();
    expect(normalizeLocalTime("not a date")).toBeNull();
  });
});

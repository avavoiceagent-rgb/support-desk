import { describe, it, expect } from "vitest";
import { bookerRoleFromText, reconcileBookerRole, parseExtraction, normalizeLocalTime } from "../extract";

describe("bookerRoleFromText", () => {
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
      expect(bookerRoleFromText(text), text).toBe(true);
    }
  });

  it("counts the writer in when they ask to be carried", () => {
    for (const text of [
      "Please pick me up at 9am.",
      "Can you collect us from Terminal B?",
      "Drop us at 245 Park Avenue.",
      "Take me to JFK on Friday.",
    ]) {
      expect(bookerRoleFromText(text), text).toBe(true);
    }
  });

  it("counts the writer in when they describe their own journey", () => {
    for (const text of [
      "I'm flying to London at 6pm.",
      "We are travelling on the 22nd.",
      "Our flight lands at 14:20.",
      "My flight departs at 18:00.",
    ]) {
      expect(bookerRoleFromText(text), text).toBe(true);
    }
  });

  it("says nothing when arranging a car is all the email says", () => {
    // "I need a car" is not "I need a car for myself". Marcus wrote exactly
    // this and was told, as fact, that he was the passenger.
    for (const text of [
      "I need a car on Monday 28 September to JFK Terminal 4.",
      "Could you send a sedan on Friday at 9am?",
      "I need a car on Friday morning. Can you help? Thanks, Marcus",
      "Please quote for a transfer from Manhattan to Newark.",
      "There will be two passengers and three bags.",
      "",
    ]) {
      expect(bookerRoleFromText(text), text).toBeNull();
    }
  });

  it("reads an email arranged for somebody else as exactly that", () => {
    for (const text of [
      "I am booking on behalf of Mr Smith. Pick him up at 9am.",
      "I am arranging a car for our client, Ms Ana Costa, on Tuesday.",
      "A car for my client, two of us will meet him there.",
      "Booking for our guest, please collect us at reception.",
    ]) {
      expect(bookerRoleFromText(text), text).toBe(false);
    }
  });

  it("recognises someone describing their own journey", () => {
    for (const text of ["My trip is on the 4th.", "I fly at 6pm.", "I'll be travelling on Tuesday."]) {
      expect(bookerRoleFromText(text), text).toBe(true);
    }
  });

  // "my trip|journey|trave" used to match anything starting "trave", so an
  // email mentioning a travel agent was read as the writer riding along, and
  // Adam told them so as fact — the exact bug the reconcile step exists to stop.
  it("does not read arranging words as the writer riding", () => {
    for (const text of [
      "My travel agent will send the itinerary.",
      "Our travel policy requires a sedan.",
      "My travel dates are the 4th and the 7th.",
    ]) {
      expect(bookerRoleFromText(text), text).toBeNull();
    }
  });

  // Naming your own traveller is positive evidence you are not the one riding,
  // with or without a "for" in front of it.
  it("reads a named traveller of one's own as somebody else", () => {
    for (const text of [
      "My traveller lands at 6pm.",
      "My passenger will be waiting in the lobby.",
      "My client needs a car on Tuesday.",
      "Our guest arrives Thursday.",
    ]) {
      expect(bookerRoleFromText(text), text).toBe(false);
    }
  });

  // ...but "my client and I" puts the writer in the car alongside them. The
  // someone-else list is checked first, so this needs guarding explicitly.
  it("still counts the writer in when they travel with the person they name", () => {
    for (const text of [
      "My client and I are flying to Miami on the 4th.",
      "My passenger and I will need the SUV.",
      "Our guest and I are heading to Newark together.",
    ]) {
      expect(bookerRoleFromText(text), text).toBe(true);
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

describe("reconcileBookerRole", () => {
  it("fills a blank from what the email said", () => {
    expect(reconcileBookerRole(null, true)).toBe(true);
    expect(reconcileBookerRole(null, false)).toBe(false);
    expect(reconcileBookerRole(null, null)).toBeNull();
  });

  it("withdraws a yes the email does not support, so Adam asks instead", () => {
    expect(reconcileBookerRole(true, null)).toBeNull();
  });

  it("corrects a yes when the email says it was arranged for someone else", () => {
    expect(reconcileBookerRole(true, false)).toBe(false);
  });

  it("keeps a yes the email backs up", () => {
    expect(reconcileBookerRole(true, true)).toBe(true);
  });

  it("leaves a stated no alone — naming another traveller is the model's job", () => {
    expect(reconcileBookerRole(false, null)).toBe(false);
    expect(reconcileBookerRole(false, true)).toBe(false);
  });
});

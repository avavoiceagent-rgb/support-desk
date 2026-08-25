import { describe, it, expect } from "vitest";
import { stripQuotedReply } from "../quoted";

describe("stripQuotedReply", () => {
  it("keeps the reply and drops the conversation under it", () => {
    // Apurva's actual reply on ticket #72.
    const body = [
      "looks good",
      "my contact number 9978615599",
      "the flight is international",
      "",
      "On Tue, Aug 25, 2026 at 2:50 PM <avavoiceagent@gmail.com> wrote:",
      "",
      "Hi Apurva,",
      "Pickup: 1 Kalisa Way, Paramus, NJ 07652",
      "for a domestic flight we'd collect you at 3:00 PM",
    ].join("\n");

    const kept = stripQuotedReply(body);
    expect(kept).toContain("the flight is international");
    expect(kept).toContain("9978615599");
    // None of our own draft survives to be read back as the customer's words.
    expect(kept).not.toContain("Kalisa Way");
    expect(kept).not.toContain("3:00 PM");
  });

  it("drops lines marked with the angle bracket", () => {
    const kept = stripQuotedReply(["Yes please", "", "> Pickup: 245 Park Ave", "> Vehicle: Sedan"].join("\n"));
    expect(kept).toBe("Yes please");
  });

  it("handles Outlook's original-message block", () => {
    const kept = stripQuotedReply(["Confirmed.", "-----Original Message-----", "From: Adam"].join("\n"));
    expect(kept).toBe("Confirmed.");
  });

  it("stops at a From: header block", () => {
    const kept = stripQuotedReply(["3pm works", "", "From: avavoiceagent@gmail.com", "Sent: Tuesday"].join("\n"));
    expect(kept).toBe("3pm works");
  });

  it("leaves an ordinary email untouched", () => {
    // The first email in a thread quotes nothing.
    const body = "Can you please arrange an airport transfer for 3 September.\nMy flight departs at 545pm.";
    expect(stripQuotedReply(body)).toBe(body);
  });

  it("does not cut a sentence that merely contains the word wrote", () => {
    const body = "I wrote to you last week about the return leg.";
    expect(stripQuotedReply(body)).toBe(body);
  });

  it("returns nothing when the message is only a quote", () => {
    // Better empty than handing an extractor our own words to read.
    expect(stripQuotedReply("> Pickup: 245 Park Ave\n> Vehicle: Sedan")).toBe("");
  });
});

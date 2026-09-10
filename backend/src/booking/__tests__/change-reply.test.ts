import { describe, it, expect } from "vitest";
import { buildChangeBrief, splitReferences, type ChangeReplyInput } from "../change-reply";

// No model and no database here. What matters about this path is what the
// model is ALLOWED to know, and that is decided entirely by the brief — so the
// brief is what gets tested. A rule enforced by a prompt is a hope; a fact the
// model was never given cannot be repeated.

const base: ChangeReplyInput = {
  customerEmail: "Could we move booking T-10312 an hour later?\n\nRegards,\nDaniel Weiss",
  placedReferences: ["T-10312"],
  unplacedReferences: [],
  mailboxName: "Ava Voice Agent",
  agentName: "{{AGENT_NAME}}",
};

describe("what the model is told", () => {
  it("passes on what the customer actually wrote", () => {
    expect(buildChangeBrief(base)).toContain("move booking T-10312 an hour later");
  });

  it("names a reference we can see, and says that is all we know about it", () => {
    const brief = buildChangeBrief(base);
    expect(brief).toContain("REFERENCES WE CAN SEE: T-10312");
    expect(brief).toContain("You know NOTHING else about them");
  });

  it("carries no detail of the booking, because it is given none", () => {
    // The guarantee this whole file exists for. The only booking-shaped thing
    // in the brief is the reference the customer themselves quoted.
    const brief = buildChangeBrief({
      ...base,
      customerEmail: "Please move my booking.",
      placedReferences: ["T-10312"],
    });
    // Values, not field names. The words "driver" and "the addresses" do
    // appear — in the sentence telling the model it does not know them — and
    // testing for those would fail on the safeguard rather than on a leak.
    for (const leak of ["Park Ave", "LaGuardia", "SEDAN", "$", "10:30", "Marco Rinaldi"]) {
      expect(brief, `the brief must not mention ${leak}`).not.toContain(leak);
    }
  });

  it("contains no time or money figure of its own", () => {
    // Sharper than the list above, and it keeps working as the wording moves:
    // the only digits in a brief should be the ones the customer wrote.
    const brief = buildChangeBrief({
      ...base,
      customerEmail: "Please move my booking.",
      placedReferences: ["T-10312"],
    });
    expect(brief).not.toMatch(/\d{1,2}[:.]\d{2}\s*(am|pm)?/i);
    expect(brief).not.toMatch(/[$£]\s*\d/);
  });

  it("tells the model to say nothing has been changed yet", () => {
    expect(buildChangeBrief(base)).toContain("NOTHING HAS BEEN CHANGED YET");
  });

  it("passes the agent placeholder through untouched", () => {
    expect(buildChangeBrief(base)).toContain("{{AGENT_NAME}}");
  });

  it("says so when they quoted no reference at all", () => {
    const brief = buildChangeBrief({ ...base, placedReferences: [], unplacedReferences: [] });
    expect(brief).toContain("they did not quote one");
  });

  it("copes with no name on the account rather than inventing one", () => {
    const brief = buildChangeBrief({ ...base, mailboxName: null });
    expect(brief).toContain("greet them without a name");
  });

  it("offers the account name only as a fallback to the sign-off", () => {
    // The bug this exists to avoid: a booker writes from a shared mailbox, and
    // the reply greets the account holder rather than the person who wrote it.
    // It cost three deploys on the new-booking path; it is not repeating here.
    const brief = buildChangeBrief(base);
    expect(brief).toContain("NAME ON THE ACCOUNT: Ava Voice Agent");
    expect(brief).toContain("This is a fallback");
    expect(brief).toContain("If they signed the email off with a name, use that one instead");
  });
});

describe("a reference we could not place", () => {
  const withUnplaced = { ...base, placedReferences: [], unplacedReferences: ["T-99999"] };

  it("asks the customer to check the number", () => {
    expect(buildChangeBrief(withUnplaced)).toContain("REFERENCES WE COULD NOT PLACE: T-99999");
    expect(buildChangeBrief(withUnplaced)).toContain("Ask the customer to check the number");
  });

  it("never explains why, because we are not told why either", () => {
    // A reference fails to place for two reasons — it does not exist, or it is
    // somebody else's — and the guard reports both identically on purpose.
    // Telling them apart in the brief would leak a stranger's booking.
    const brief = buildChangeBrief(withUnplaced);
    expect(brief).toContain("Do not say why");
    expect(brief.toLowerCase()).not.toContain("belongs to");
    expect(brief.toLowerCase()).not.toContain("another customer");
    expect(brief.toLowerCase()).not.toContain("does not exist");
  });

  it("keeps the two kinds apart when an email quotes both", () => {
    const brief = buildChangeBrief({
      ...base,
      placedReferences: ["T-10312"],
      unplacedReferences: ["T-99999", "INV-10032"],
    });
    expect(brief).toContain("REFERENCES WE CAN SEE: T-10312");
    expect(brief).toContain("REFERENCES WE COULD NOT PLACE: T-99999, INV-10032");
  });
});

describe("splitting what they quoted", () => {
  it("places everything that is not on the unplaced list", () => {
    expect(splitReferences(["T-10312", "T-10313"], [])).toEqual({
      placed: ["T-10312", "T-10313"],
      unplaced: [],
    });
  });

  it("separates the ones we could not place", () => {
    expect(splitReferences(["T-10312", "T-99999", "INV-10032"], ["T-99999", "INV-10032"])).toEqual({
      placed: ["T-10312"],
      unplaced: ["T-99999", "INV-10032"],
    });
  });

  it("keeps the customer's own order, so the reply reads the way they wrote it", () => {
    expect(splitReferences(["INV-10032", "T-10312", "T-99999"], ["T-99999", "INV-10032"])).toEqual({
      placed: ["T-10312"],
      unplaced: ["INV-10032", "T-99999"],
    });
  });

  it("never invents a reference nobody quoted", () => {
    // The unplaced list arrives from elsewhere; anything in it that the
    // customer did not actually write has no business in the reply.
    expect(splitReferences(["T-10312"], ["T-55555"])).toEqual({
      placed: ["T-10312"],
      unplaced: [],
    });
  });

  it("treats an email with no references as nothing to ask about", () => {
    expect(splitReferences([], ["T-99999"])).toEqual({ placed: [], unplaced: [] });
  });
});

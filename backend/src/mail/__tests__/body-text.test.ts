// The email as a model should see it — lines and all.
//
// These exist because the flattening they guard against was invisible: no
// error, no wrong-looking output, just an extractor quietly reading a sign-off
// that no longer looked like one, and a quote-stripper handed a single line
// with nothing to strip. The symptom reached Amar as a booking signed "Priya
// Raman" arriving under his own name.

import { describe, it, expect } from "vitest";
import { toModelText } from "../body-text";
import { toPlainText } from "../../ai/classifier";
import { stripQuotedReply } from "../quoted";

const SIGNED_OFF = [
  "Hello,",
  "",
  "Do you cover a run from JFK Terminal 4 to the Sheraton Philadelphia Downtown?",
  "",
  "Many thanks,",
  "Priya Raman",
  "+1 646 555 0188",
].join("\n");

describe("toModelText", () => {
  it("leaves a sign-off on a line of its own", async () => {
    // The whole point. The extraction prompt is written around sign-offs
    // looking like sign-offs, and its worked example is a name on its own
    // line. Flattened, "Many thanks, Priya Raman +1 646 555 0188" is prose.
    const text = toModelText("", SIGNED_OFF);
    expect(text).toContain("Many thanks,\nPriya Raman");
  });

  it("is not what toPlainText does — which is the bug it exists for", async () => {
    // Guards the pair, not just the new one. If toPlainText ever stopped
    // flattening, this file would be dead weight and should say so.
    expect(toPlainText("", SIGNED_OFF)).not.toContain("\n");
    expect(toModelText("", SIGNED_OFF)).toContain("\n");
  });

  it("collapses runs of spaces but never newlines", async () => {
    expect(toModelText("", "one    two\nthree")).toBe("one two\nthree");
  });

  it("caps a run of blank lines at one", async () => {
    // One blank line is a paragraph. Six is an editor.
    expect(toModelText("", "top\n\n\n\n\nbottom")).toBe("top\n\nbottom");
  });

  it("turns block ends into line breaks when there is only HTML", async () => {
    // One newline per block end, not two — so a paragraph break and a <br>
    // come out the same. Recorded rather than wished for: the lines are what
    // the sign-off rule and `stripQuotedReply` both work on, and neither cares
    // whether there is a blank line between paragraphs.
    const html = "<p>Many thanks,</p><p>Priya Raman<br>+1 646 555 0188</p>";
    expect(toModelText(html).split("\n")).toEqual([
      "Many thanks,",
      "Priya Raman",
      "+1 646 555 0188",
    ]);
  });

  it("prefers the plain-text part when the mail carried one", async () => {
    expect(toModelText("<p>from the html</p>", "from the text part")).toBe("from the text part");
  });

  it("falls back to the HTML when the text part is blank rather than absent", async () => {
    // An empty string is not a text part. Trusting it returns nothing at all.
    expect(toModelText("<p>from the html</p>", "   ")).toBe("from the html");
  });

  it("reads the entities sanitizeBody writes", async () => {
    expect(toModelText("", "Ben &amp; Jerry&#39;s &lt;tag&gt;")).toBe("Ben & Jerry's <tag>");
  });

  it("does not turn an escaped entity into markup", async () => {
    // &amp; is unescaped last, so "&amp;lt;" is the text "&lt;", not "<".
    expect(toModelText("", "&amp;lt;")).toBe("&lt;");
  });

  it("normalises Windows line endings", async () => {
    expect(toModelText("", "one\r\ntwo")).toBe("one\ntwo");
  });
});

describe("toModelText and stripQuotedReply together", () => {
  // This pairing is the one that actually reached a customer. `stripQuotedReply`
  // splits on newlines, so flattened text is a single line: nothing matches,
  // nothing is stripped, and the extractor is handed our own quoted draft —
  // greeting included — as though the customer had written it. That greeting
  // carried the guessed name, so the guess fed itself.
  const REPLY = [
    "The flight is international, and my number is +1 646 555 0188.",
    "",
    "On Mon, Aug 24, 2026 at 7:45 AM <support@ourcompany.example> wrote:",
    "> Dear Amar Pant,",
    "> Thank you for your enquiry. Could you confirm the flight number?",
  ].join("\n");

  it("strips the quote when the lines survive", async () => {
    const said = stripQuotedReply(toModelText("", REPLY));
    expect(said).toBe("The flight is international, and my number is +1 646 555 0188.");
    expect(said).not.toContain("Amar Pant");
  });

  it("strips nothing at all when the text has been flattened first", async () => {
    // The failure, written down. Not a wish about the future: if this ever
    // starts passing, the two functions have converged and the pair above is
    // no longer proving anything.
    const said = stripQuotedReply(toPlainText("", REPLY));
    expect(said).toContain("Dear Amar Pant");
  });
});

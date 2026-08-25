// An email body as a model should see it.
//
// `toPlainText` in ai/classifier.ts collapses every run of whitespace to a
// single space, newlines included. For triage that is right: the question
// there is "what kind of email is this", the answer does not depend on layout,
// and flattening saves tokens.
//
// For anything that reads the email for *facts* it is wrong, because an email
// carries meaning in its lines:
//
//   Many thanks,
//   Priya Raman
//   +1 646 555 0188
//
// flattens to "... Many thanks, Priya Raman +1 646 555 0188", and the
// extraction prompt is written around sign-offs looking like sign-offs — its
// worked example is `"Regards, Daniel Weiss"` on a line of its own. Meanwhile
// the mailbox display name, which that prompt calls the weaker signal, arrives
// on a tidy line of its own in the `From:` header. Flattening degrades the
// evidence the prompt says should win and leaves the evidence it says should
// lose untouched.
//
// `stripQuotedReply` has it worse: it splits on newlines, so text that has
// already been flattened has exactly one line and nothing is ever stripped.
//
// So: strip the markup, keep the lines. Horizontal whitespace is still
// collapsed — a run of spaces carries nothing — and blank lines are capped at
// one, because the shape is what matters, not the spacing.

/** Tags that end a line when HTML is turned back into text. */
const BLOCK_END =
  /<\s*(?:br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/blockquote|\/pre|\/table)\b[^>]*>/gi;

/** The handful of entities that actually turn up; `sanitizeBody` writes three. */
const ENTITIES: [RegExp, string][] = [
  [/&nbsp;/gi, " "],
  [/&lt;/gi, "<"],
  [/&gt;/gi, ">"],
  [/&quot;/gi, '"'],
  [/&#0*39;|&apos;/gi, "'"],
  // Last, so a literal "&amp;lt;" does not become "<".
  [/&amp;/gi, "&"],
];

/**
 * The text of a message body, with its line structure intact.
 *
 * Prefers the plain-text part when the mail carried one, exactly as
 * `toPlainText` does; falls back to converting the stored HTML.
 */
export function toModelText(html: string, fallbackText?: string | null): string {
  let source = fallbackText?.trim()
    ? fallbackText
    : html.replace(BLOCK_END, "\n").replace(/<[^>]*>/g, " ");

  for (const [pattern, replacement] of ENTITIES) source = source.replace(pattern, replacement);

  return source
    .replace(/\r\n?/g, "\n")
    // Spaces and tabs collapse; newlines survive. `\s` would eat both.
    .replace(/[^\S\n]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    // One blank line is a paragraph break; six is just an editor.
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

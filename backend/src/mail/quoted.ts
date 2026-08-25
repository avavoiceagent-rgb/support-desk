// Removing the part of a reply that is our own email quoted back at us.
//
// A customer answering "the flight is international" sends four lines of
// their own and forty of ours underneath, marked with > or introduced by
// "On Tuesday, X wrote:". Reading the whole thing back into an extractor
// means re-reading our own draft as though the customer had written it: the
// addresses we proposed, the times we suggested, the questions we asked.
//
// Nothing here is clever. Quoting conventions are a mess and always will be,
// so this only removes what it is sure about and leaves anything ambiguous
// in place — a reply that keeps too much is a re-read that wastes a model
// call, while one that cuts too much silently loses what the customer said.

/**
 * Lines that introduce a quoted block.
 *
 * Gmail, Outlook and Apple Mail all write some variation of these. Anchored
 * to the start so a sentence merely containing "wrote" is left alone.
 */
const QUOTE_HEADERS = [
  // "On Mon, Aug 24, 2026 at 7:45 AM <someone@example.com> wrote:"
  /^on\s.+\bwrote:\s*$/i,
  // Outlook's block, in several languages' worth of punctuation.
  /^-{2,}\s*original message\s*-{2,}$/i,
  /^_{5,}$/,
  /^from:\s.+$/i,
  /^sent from my \w+/i,
];

/** A line that is itself quoted material. */
function isQuotedLine(line: string): boolean {
  return /^\s*>/.test(line);
}

/**
 * The customer's own words, with the quoted conversation below them removed.
 *
 * Everything from the first quote marker onwards goes, because replies are
 * written above the quote in every mail client this desk will meet. Text
 * that is entirely quoted comes back empty rather than as the quote itself.
 */
export function stripQuotedReply(body: string): string {
  const lines = body.split(/\r?\n/);
  const kept: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (QUOTE_HEADERS.some((pattern) => pattern.test(line.trim()))) break;
    if (isQuotedLine(line)) {
      // A single quoted line in the middle of a sentence is unusual enough
      // that stopping on it would cut real text. Stop only when the quote
      // continues — which is what a quoted conversation actually looks like.
      const next = lines[i + 1];
      if (next === undefined || isQuotedLine(next) || next.trim() === "") break;
      continue;
    }
    kept.push(line);
  }

  return kept.join("\n").trim();
}

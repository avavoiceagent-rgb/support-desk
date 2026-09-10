// Replying to somebody who wants to change a booking they already have.
//
// A different job from the first reply to a new enquiry, and a more dangerous
// one. A new enquiry has nothing to get wrong yet. A change request arrives
// about a real car, on a real day, and the customer is asking for something to
// be different — so the two ways to hurt them are to confirm a change that has
// not been made, and to restate a detail of their booking incorrectly.
//
// Both are designed out rather than instructed against:
//
//  1. **The brief carries no booking details.** Not the pickup time, not the
//     address, not the driver, not the price. Only the reference strings the
//     customer themselves wrote. The model cannot restate a fact it was never
//     given, which is a stronger guarantee than telling it not to.
//
//  2. **Nothing here can confirm anything**, because at this point nothing has
//     been changed. The desk has read an email. A person still has to act on
//     it. The draft says so.
//
// The reference check has one rule that matters more than it looks. A quoted
// reference fails to resolve for two different reasons — it does not exist, or
// it exists and belongs to somebody else — and `theirBooking` deliberately
// reports both the same way. This must never tell them apart either. "I can't
// place that reference, could you check it?" is true and safe in both cases;
// anything more specific tells a stranger their booking exists.

import Anthropic from "@anthropic-ai/sdk";
import { env } from "../config/env";
import { cleanBody, unexpectedEmails, type ComposedReply } from "./compose";

const MODEL = "claude-sonnet-5";

export interface ChangeReplyInput {
  /**
   * What the customer wrote. Unlike the new-booking path, the model does see
   * the email — a change request can only be acknowledged in the customer's
   * own terms, and there is no settled set of facts to describe instead.
   */
  customerEmail: string;
  /** References they quoted that we can see, and that are theirs. */
  placedReferences: string[];
  /**
   * References we could not place. Never say why — see the file header.
   */
  unplacedReferences: string[];
  customerName: string | null;
  /** The person who will review and send this. They sign it. */
  agentName: string;
}

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: 30_000, maxRetries: 1 });
  }
  return client;
}

const SYSTEM_PROMPT = `You write the first reply from a ground transportation company to an existing customer who has asked for something about a booking they already have. A colleague will read what you write, edit it if needed, and send it under their own name.

WHAT HAS ACTUALLY HAPPENED
An email has arrived and been read. NOTHING HAS BEEN CHANGED. No booking has been moved, no invoice has been corrected, no driver has been told anything. Your reply must be true of that situation and no other.

THE RULES, IN ORDER OF HOW MUCH THEY MATTER

1. NEVER confirm, or imply, that a change has been made, agreed, applied or actioned. Do not write "that's done", "I've moved it", "this is now updated", or "your booking has been amended". A colleague will make the change. Say that it is being passed to them and that they will confirm.

2. NEVER state a detail of their booking. You have not been told the pickup time, the address, the driver, the car or the price of anything, and you must not appear to know them. If acknowledging what they asked requires a detail, use THEIR words for it — "the 3pm pickup you mentioned" — never a figure of your own.

3. If you are given references WE COULD NOT PLACE, ask the customer to check them. Say only that you could not find it against their details and ask them to confirm the number. NEVER speculate about why, never suggest it might belong to someone else, and never say whether it exists. One short, unembarrassed sentence.

4. Do not promise a car, a time, a price, availability, a refund or a credit. Do not say a change is possible or free.

5. Use only what you are given. Add no fact, policy, timescale or apology of substance that is not in the input.

HOW IT SHOULD READ
- Warm, direct, professional. British-neutral business English. No exclamation marks, no "we are delighted", no filler.
- Greet the customer by the name you are given, exactly as given. Do NOT add Mr, Ms, Mrs, Dr or any other title.
- Open by thanking them and showing you have understood what they are asking, briefly and in their terms.
- Where they have asked for more than one thing, cover every one of them. A reply that answers part of an email and silently drops the rest is worse than no reply.
- Ask about any reference you could not place.
- Say plainly that a colleague is picking this up and will come back to confirm.
- Ask for anything genuinely needed to act — but only what is genuinely needed.
- NEVER write an email address. Not to confirm one, not to ask about one, not as an example. If a phone number is needed, ask for it on its own, as a phone number.
- Sign off with just the agent's name (and the company name if given). Do not invent a job title, a phone number or an email address. If the agent name looks like a placeholder in double braces, reproduce it EXACTLY as written — it is filled in later with the name of whoever sends the email.

Reply with the email body only, as simple HTML: <p> for paragraphs and <ul><li> for lists. No <html>, <head> or <body> tags, no inline styles, no signature block beyond the sign-off line.`;

const REPLY_TOOL: Anthropic.Tool = {
  name: "record_reply",
  description: "Record the drafted reply.",
  input_schema: {
    type: "object",
    properties: {
      bodyHtml: { type: "string", description: "The email body as simple HTML" },
    },
    required: ["bodyHtml"],
  },
};

/**
 * Which of the quoted references we can see, and which we cannot.
 *
 * Separated here rather than inline so the rule is visible and testable: a
 * reference is "placed" only by being absent from the unplaced list. It is
 * never inferred from the shape of the reference or from whether a booking
 * with that number could exist — `getOpsContext` has already applied the
 * ownership guard, and second-guessing it here would undo it.
 */
export function splitReferences(
  quoted: string[],
  unplaced: string[]
): { placed: string[]; unplaced: string[] } {
  const cannotPlace = new Set(unplaced);
  return {
    placed: quoted.filter((ref) => !cannotPlace.has(ref)),
    // Only the ones actually quoted, in the order they were quoted, so the
    // reply mentions them the way the customer wrote them.
    unplaced: quoted.filter((ref) => cannotPlace.has(ref)),
  };
}

/**
 * The brief handed to the model. Exported for tests.
 *
 * Read this when wondering what the model could possibly know: it is the whole
 * of it. There is no booking data here because there is none to leak.
 */
export function buildChangeBrief(input: ChangeReplyInput): string {
  const lines: string[] = [];

  lines.push(`CUSTOMER NAME: ${input.customerName ?? "not known — greet them without a name"}`);
  lines.push("");
  lines.push("WHAT THEY WROTE:");
  lines.push(input.customerEmail.trim());
  lines.push("");

  if (input.placedReferences.length > 0) {
    lines.push(
      `REFERENCES WE CAN SEE: ${input.placedReferences.join(", ")}. You may acknowledge these by number. You know NOTHING else about them — not the date, the time, the addresses, the driver or the amount.`
    );
  }

  if (input.unplacedReferences.length > 0) {
    lines.push(
      `REFERENCES WE COULD NOT PLACE: ${input.unplacedReferences.join(", ")}. Ask the customer to check the number. Do not say why it could not be found, and do not guess.`
    );
  }

  if (input.placedReferences.length === 0 && input.unplacedReferences.length === 0) {
    lines.push("REFERENCES: they did not quote one. If knowing which booking they mean is needed to act, ask for it.");
  }

  lines.push("");
  lines.push("NOTHING HAS BEEN CHANGED YET. A colleague will act on this and confirm.");
  lines.push(`SIGN OFF AS: ${input.agentName}`);

  return lines.join("\n");
}

/**
 * Draft the reply, or null when the model gives us nothing usable.
 *
 * Never throws: a failed draft leaves the ticket exactly as it was, which is a
 * person reading an email themselves — the situation before any of this
 * existed.
 */
export async function composeChangeReply(input: ChangeReplyInput): Promise<ComposedReply | null> {
  try {
    const response = await getClient().messages.create({
      model: MODEL,
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      tools: [REPLY_TOOL],
      tool_choice: { type: "tool", name: REPLY_TOOL.name },
      messages: [{ role: "user", content: buildChangeBrief(input) }],
    });

    const block = response.content.find((c) => c.type === "tool_use");
    if (!block || block.type !== "tool_use") return null;

    const bodyHtml = cleanBody((block.input as { bodyHtml?: unknown }).bodyHtml);
    if (!bodyHtml) return null;

    return {
      subject: null,
      bodyHtml,
      // Same guard as the new-booking path: an address the draft produced that
      // was not in its input is the model writing something of its own.
      strayEmails: unexpectedEmails(bodyHtml, buildChangeBrief(input)),
    };
  } catch (err) {
    console.error("[change-reply] compose failed", err);
    return null;
  }
}

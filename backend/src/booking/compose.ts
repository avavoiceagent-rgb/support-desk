// Writing the reply.
//
// By the time we get here every fact is settled: addresses verified against a
// map, the pickup time worked out in code, the questions decided by rules. The
// model's only job is to turn that into an email a customer would be happy to
// receive. It is told, firmly, that it may not add anything of its own.
//
// The draft is never sent automatically. A person reads it, edits it, sends it
// under their own name.

import Anthropic from "@anthropic-ai/sdk";
import { env, isClassifierConfigured } from "../config/env";
import { describeLocal } from "./pickup-time";
import type { PickupPlan } from "./pickup-time";
import type { BookingReview } from "./questions";
import { describeRate, type RateEstimate } from "./rates";

const MODEL = "claude-sonnet-5";

export interface ComposeInput {
  review: BookingReview;
  plan: PickupPlan;
  rate: RateEstimate | null;
  /** Whoever the email came from, for the greeting. */
  customerName: string | null;
  /** The trip leaves the service area, so a partner has to cover it. */
  isExternal: boolean;
  /** The person who will review and send this. They sign it. */
  agentName: string;
}

export interface ComposedReply {
  /**
   * Addresses the draft mentioned that were not in its input — see
   * `unexpectedEmails`. Empty on every well-behaved draft.
   */
  strayEmails?: string[];
  subject: string | null;
  bodyHtml: string;
}

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: 30_000, maxRetries: 1 });
  }
  return client;
}

const SYSTEM_PROMPT = `You write the first reply from a ground transportation company to someone who has asked to book a car. A colleague will read what you write, edit it if needed, and send it under their own name.

WHAT YOU ARE GIVEN
- CONFIRMED: facts already established — addresses checked against a map, times calculated. Repeat these for the customer to check.
- STILL NEEDED: things the email did not say. Ask for these, in a natural way.
- TIMING: a pickup time worked out from the flight and the real drive time, where that applied.
- MARKET RATE: an optional rough price range with sources.

THE RULE
Use only what you are given. Do not add a fact, a time, a postcode, a price, a policy or a promise that is not in the input. If something is not there, it is not known — and the STILL NEEDED list already covers it. You are writing, not deciding.

HOW IT SHOULD READ
- Warm, direct, professional. British-neutral business English. No exclamation marks, no "we are delighted", no filler.
- Greet the customer by the name you are given, exactly as given. Do NOT add Mr, Ms, Mrs, Dr or any other title — a name says nothing about someone's gender or how they wish to be addressed, and getting it wrong is worse than not trying.
- Open by thanking them and saying you are getting the booking set up.
- Confirm the details as a short list they can scan and correct.
- Then ask what is still needed — as few, and as plainly, as possible. Group related questions into one sentence where it reads better. Never ask for something that is already in the confirmed list.
- NEVER write an email address. Not to confirm one, not to ask about one, not as an example. If a phone number is needed, ask for it on its own, as a phone number.
- If a suggested pickup time is given, explain WHY in one clause — the airport wants them there a set time before the flight, and the drive takes what it takes. If the time they asked for would be too late, say so plainly and kindly; do not bury it.
- If a market rate is given, present it as a rough guide with our own price to follow. Never as a quote.
- Close by saying you'll confirm everything once they come back.
- Sign off with just the agent's name (and the company name if given). Do not invent a job title, a phone number or an email address. If the agent name you are given looks like a placeholder in double braces, reproduce it EXACTLY as written — it is filled in later with the name of whoever sends the email.

IF THE TRIP IS EXTERNAL: it has to be covered by a partner operator, so do NOT confirm a vehicle or availability. Say you are checking availability and will confirm shortly. Everything else is the same.

Reply with the email body only, as simple HTML: <p> for paragraphs and <ul><li> for lists. No <html>, <head> or <body> tags, no inline styles, no signature block beyond the sign-off line.`;

const COMPOSE_TOOL: Anthropic.Tool = {
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

/** Exported for tests: the brief handed to the model, built from settled facts. */
export function buildBrief(input: ComposeInput): string {
  const { review, plan } = input;
  const lines: string[] = [];

  lines.push(`CUSTOMER: ${input.customerName ?? "unknown — open without using a name"}`);
  lines.push(`AGENT SIGNING: ${input.agentName}`);
  if (env.COMPANY_NAME) lines.push(`COMPANY: ${env.COMPANY_NAME}`);
  lines.push(`TRIP IS EXTERNAL (partner-covered, do not promise a vehicle): ${input.isExternal ? "yes" : "no"}`);

  lines.push("", "CONFIRMED:");
  if (review.confirmations.length) review.confirmations.forEach((c) => lines.push(`- ${c}`));
  else lines.push("- (nothing established yet)");

  lines.push("", "STILL NEEDED:");
  if (review.questions.length) review.questions.forEach((q) => lines.push(`- ${q}`));
  else lines.push("- (nothing — everything needed is confirmed)");

  const recommended = describeLocal(plan.recommendedPickupLocal);
  const mustArrive = describeLocal(plan.mustArriveAtLocal);

  // Collecting somebody off a plane has no arithmetic behind it, so there is
  // none to explain. Adam was telling a customer that "the drive from JFK to
  // Midtown runs about 51 minutes, plus a further 15 we build in as a buffer"
  // — both true of the journey and neither relevant to when the car turns up,
  // because that drive happens after the passenger is in it.
  if (plan.collectedOnArrival && recommended) {
    lines.push("", "TIMING:");
    lines.push(`- The car meets the flight. Pickup is ${recommended}, when it lands.`);
    lines.push(
      "- Say the driver will be there for the landing and will wait. Do NOT mention drive time, traffic or any buffer: none of it moves this pickup."
    );
  } else if (recommended || mustArrive) {
    lines.push("", "TIMING:");
    if (mustArrive && plan.leadMinutes) {
      lines.push(
        `- The airport asks for arrival ${plan.leadMinutes / 60} hours before the flight, which means being there by ${mustArrive}.`
      );
    }
    if (plan.driveMinutes !== null) {
      lines.push(`- The drive takes about ${plan.driveMinutes} minutes in current traffic.`);
    }
    if (plan.stopAllowanceMinutes > 0) {
      lines.push(`- Allowing ${plan.stopAllowanceMinutes} minutes for the stop(s) along the way.`);
    }
    if (plan.bufferMinutes > 0 && plan.driveMinutes !== null) {
      // Said out loud because the customer will notice the extra quarter hour
      // and, unexplained, it reads as the desk being careless with their day.
      lines.push(
        `- Plus ${plan.bufferMinutes} minutes of our own on top of the drive, in case the traffic is worse than it looks today. Mention this: it is why the pickup is earlier than the bare arithmetic, and it is deliberate.`
      );
    }
    if (recommended) lines.push(`- Suggested pickup: ${recommended}.`);
    if (plan.requestedIsTooLate && plan.shortfallMinutes !== null) {
      lines.push(
        `- IMPORTANT: the time the customer asked for is ${plan.shortfallMinutes} minutes too late to make that. Tell them, and suggest the time above.`
      );
    }
  }

  if (review.vehicleSuggestion) {
    lines.push("", `VEHICLE: ${review.vehicleSuggestion}`);
  }

  const rate = describeRate(input.rate);
  if (rate) lines.push("", `MARKET RATE (a rough guide, never our quote): ${rate}`);

  return lines.join("\n");
}

/**
 * Email addresses the draft mentions that were never in its input.
 *
 * Three separate drafts have now asked a customer whether their email address
 * is a phone number. The first fix was an instruction forbidding it by name;
 * the second removed the email from the facts entirely — and the third draft
 * still produced an address that appears nowhere in what the model was given.
 *
 * At that point another instruction is not a fix. This checks the output
 * instead of trusting it: anything shaped like an address, that is not in the
 * brief, gets named for a person to look at before the reply goes anywhere.
 */
// The domain is spelled out label by label so a sentence-ending full stop
// cannot be swallowed into the address: "…at ana@customer.example." matched
// with the dot attached, which then looked like an address nobody had given.
const EMAIL_SHAPED = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

export function unexpectedEmails(bodyHtml: string, brief: string): string[] {
  const inBrief = new Set((brief.match(EMAIL_SHAPED) ?? []).map((e) => e.toLowerCase()));
  const found = bodyHtml.match(EMAIL_SHAPED) ?? [];
  return [...new Set(found.map((e) => e.toLowerCase()))].filter((e) => !inBrief.has(e));
}

/** Strip anything the model shouldn't have sent us, and check it wrote something. */
export function cleanBody(html: unknown): string | null {
  if (typeof html !== "string") return null;
  const cleaned = html
    .replace(/```html|```/g, "")
    .replace(/<\/?(?:html|head|body|script|style)[^>]*>/gi, "")
    .trim();
  return cleaned.length > 40 ? cleaned : null;
}

export async function composeReply(input: ComposeInput): Promise<ComposedReply | null> {
  if (!isClassifierConfigured) return null;

  try {
    const brief = buildBrief(input);
    const response = await getClient().messages.create({
      model: MODEL,
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      tools: [COMPOSE_TOOL],
      tool_choice: { type: "tool", name: COMPOSE_TOOL.name },
      messages: [{ role: "user", content: brief }],
    });

    if (response.stop_reason === "max_tokens") {
      console.error("[compose] reply truncated; discarding");
      return null;
    }
    const toolUse = response.content.find((b) => b.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") return null;

    const bodyHtml = cleanBody((toolUse.input as Record<string, unknown>)?.bodyHtml);
    if (!bodyHtml) return null;

    // The reply goes out on the existing email thread, which already carries
    // the subject; leaving it null keeps the threading intact.
    return { subject: null, bodyHtml, strayEmails: unexpectedEmails(bodyHtml, brief) };
  } catch (err) {
    console.error("[compose] failed:", err);
    return null;
  }
}

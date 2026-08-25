// An indicative market price for a journey, found by searching the web.
//
// A caution worth keeping in the file: these numbers are NOT this company's
// prices. They come from whatever operators and aggregators have published,
// which vary by vehicle class, time of day and how old the page is. The draft
// therefore presents a RANGE, labels it as a market estimate, and shows where
// it came from — and a person reads it before the customer ever does.
//
// If the search finds nothing usable, that is a perfectly good outcome: the
// draft simply says a quote will follow.

import Anthropic from "@anthropic-ai/sdk";
import { env, isClassifierConfigured } from "../config/env";

/**
 * Server-side web search is only supported on some models, and the set moves.
 * Configurable so it can be changed without a deploy if a call starts failing.
 */
const RATES_MODEL = env.RATES_MODEL || "claude-sonnet-5";

export interface RateSource {
  title: string;
  url: string;
}

export interface RateEstimate {
  low: number;
  high: number;
  currency: string;
  /** e.g. "sedan, one way, before tolls and gratuity" */
  basis: string;
  sources: RateSource[];
}

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) {
    // Searching plus reasoning takes longer than a classification, but this
    // runs in the background so a slow answer costs nothing.
    client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: 60_000, maxRetries: 1 });
  }
  return client;
}

const SYSTEM_PROMPT = `You research typical market prices for private car service (black car / chauffeur) journeys in the United States, so a support agent has a rough idea of the going rate before they quote.

Search for what operators publish for the specific journey asked about. Prefer named car service operators' own rate pages and airport transfer price lists over forums, blogs and general "how much does a taxi cost" articles.

Report a RANGE, not a single figure, because the real number depends on vehicle class, time of day and demand. State plainly what the range covers — typically a sedan, one way, before tolls, parking and gratuity.

Answer with nothing at all rather than a guess. If you cannot find figures for this journey, or only find prices for a different service (a taxi meter, a rideshare estimate, a different city), record no estimate. A missing number is fine; a wrong one is repeated to a customer.

Never present these as the company's own prices. They are market context.`;

const RATE_TOOL: Anthropic.Tool = {
  name: "record_rate_estimate",
  description:
    "Record an indicative market price range for this journey. Omit everything if you could not find reliable figures.",
  input_schema: {
    type: "object",
    properties: {
      low: { type: "number", description: "Lower end of the range" },
      high: { type: "number", description: "Upper end of the range" },
      currency: { type: "string", description: "ISO code, e.g. USD" },
      basis: {
        type: "string",
        description: "What the range covers, e.g. 'sedan, one way, before tolls and gratuity'",
      },
      sources: {
        type: "array",
        items: {
          type: "object",
          properties: { title: { type: "string" }, url: { type: "string" } },
          required: ["title", "url"],
        },
      },
    },
    required: [],
  },
};

/** Exported for tests: keep only a range that makes sense to show someone. */
export function parseRateEstimate(raw: unknown): RateEstimate | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : null;

  const low = num(r.low);
  const high = num(r.high);
  // A one-sided or inverted range is a sign the model was improvising.
  if (low === null || high === null || high < low) return null;
  // A "range" spanning an order of magnitude tells the customer nothing.
  if (high > low * 6) return null;

  const sources = Array.isArray(r.sources)
    ? r.sources
        .map((s) => {
          const o = s as Record<string, unknown>;
          const url = typeof o?.url === "string" ? o.url.trim() : "";
          const title = typeof o?.title === "string" ? o.title.trim() : "";
          if (!url.startsWith("http")) return null;
          return { title: title || url, url };
        })
        .filter((s): s is RateSource => s !== null)
        .slice(0, 4)
    : [];

  // Without a source the reviewer has no way to sanity-check the figure, and
  // an unsourced number in a customer email is exactly what we set out to avoid.
  if (sources.length === 0) return null;

  return {
    low,
    high,
    currency: typeof r.currency === "string" && r.currency.trim() ? r.currency.trim().toUpperCase() : "USD",
    basis:
      typeof r.basis === "string" && r.basis.trim()
        ? r.basis.trim().slice(0, 200)
        : "sedan, one way, before tolls and gratuity",
    sources,
  };
}

export interface RateLookupInput {
  pickupDescription: string;
  dropoffDescription: string;
  miles?: number | null;
  vehicle?: string | null;
}

export async function lookupIndicativeRate(input: RateLookupInput): Promise<RateEstimate | null> {
  if (!isClassifierConfigured) return null;

  try {
    const distance = input.miles ? ` The journey is roughly ${input.miles} miles.` : "";
    const vehicle = input.vehicle ? ` The customer asked for a ${input.vehicle}.` : "";
    const question = `What do private car services typically charge for a journey from ${input.pickupDescription} to ${input.dropoffDescription}?${distance}${vehicle}`;

    const response = await getClient().messages.create({
      model: RATES_MODEL,
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      tools: [
        { type: "web_search_20250305", name: "web_search", max_uses: 4 } as unknown as Anthropic.Tool,
        RATE_TOOL,
      ],
      messages: [{ role: "user", content: question }],
    });

    const toolUse = response.content.find(
      (b) => b.type === "tool_use" && b.name === RATE_TOOL.name
    );
    if (!toolUse || toolUse.type !== "tool_use") return null;

    return parseRateEstimate(toolUse.input);
  } catch (err) {
    // Most likely causes: the model doesn't support server-side search, or the
    // search itself failed. Either way the draft goes out without a figure.
    console.error(`[rates] lookup failed (model ${RATES_MODEL}):`, err);
    return null;
  }
}

/** How the range should read in an email — always hedged, never "our price". */
/**
 * The range on its own, for a sentence somebody else is writing.
 *
 * `describeRate` returns a whole sentence, which is right for a draft and
 * wrong inside one. Dropped into "the market range is ${...}" it produced
 * "the market range is As a rough guide, published market rates for this
 * journey run about $480–$675 (...). We'll confirm our own price separately."
 * — two sentences wearing each other's clothes, on an internal note a
 * dispatcher has to read at speed.
 */
export function rateRange(estimate: RateEstimate | null): string | null {
  if (!estimate) return null;
  const money = (n: number) => (estimate.currency === "USD" ? `$${n}` : `${n} ${estimate.currency}`);
  return `${money(estimate.low)}–${money(estimate.high)} (${estimate.basis})`;
}

export function describeRate(estimate: RateEstimate | null): string | null {
  if (!estimate) return null;
  const money = (n: number) => (estimate.currency === "USD" ? `$${n}` : `${n} ${estimate.currency}`);
  return `As a rough guide, published market rates for this journey run about ${money(estimate.low)}–${money(estimate.high)} (${estimate.basis}). We'll confirm our own price separately.`;
}

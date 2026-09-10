import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  PORT: z.string().default("4000").transform(Number),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  APP_BASE_URL: z.string().url(),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(16, "JWT_SECRET must be set to a long random string"),
  ENCRYPTION_KEY: z.string().min(1),
  GOOGLE_CLIENT_ID: z.string().optional().default(""),
  GOOGLE_CLIENT_SECRET: z.string().optional().default(""),
  GOOGLE_REDIRECT_URI: z.string().optional().default(""),
  MAIL_POLL_INTERVAL_MS: z.string().default("60000").transform(Number),
  // Optional shared secret that lets an external scheduler (e.g. a cron
  // pinger) trigger a mail poll without a login session — used on free-tier
  // hosting where the app may sleep between requests.
  CRON_SECRET: z.string().optional().default(""),
  // Optional. When empty, AI triage is simply switched off and everything
  // else keeps working exactly as before.
  ANTHROPIC_API_KEY: z.string().optional().default(""),
  // Optional. Enables verified addresses (Geocoding API) and traffic-aware
  // drive times (Routes API). Without it, Adam echoes addresses back as the
  // customer wrote them and asks them to confirm.
  GOOGLE_MAPS_API_KEY: z.string().optional().default(""),
  // Which model does the rate web-search. Server-side search is only
  // supported on some models and the set moves, so this is changeable
  // without a deploy.
  RATES_MODEL: z.string().optional().default(""),
  // Shown in Adam's drafts. Left empty, the company name is simply omitted.
  COMPANY_NAME: z.string().optional().default(""),
  // What we add to a partner's quote to get the customer's price, as a
  // percentage. One figure for every job, which is how Amar runs it. Change
  // it in Railway; nothing needs a deploy.
  PARTNER_MARGIN_PERCENT: z.string().default("25").transform(Number),
  // --- SantaCruz, the reservation system the company is moving to ---
  //
  // Optional, and off until both a key and a base URL exist. Nothing about
  // the desk changes while they are empty: the SantaCruz screens simply say
  // they are not connected yet, and the mapping can still be built and tested
  // against a file with no credentials at all.
  //
  // The key lives here and only here. It is never written to the database and
  // never sent to a screen — the connection page reports whether one is set,
  // never what it is.
  SANTACRUZ_API_KEY: z.string().optional().default(""),
  // The shared secret SantaCruz presents when it calls US, which is the
  // opposite direction and a different secret on purpose: leaking one does
  // not hand over the other.
  SANTACRUZ_INBOUND_KEY: z.string().optional().default(""),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:");
  console.error(parsed.error.flatten().fieldErrors);
  throw new Error("Invalid environment configuration. Check backend/.env against .env.example.");
}

export const env = parsed.data;

/** AI triage only runs when an Anthropic API key is configured. */
export const isClassifierConfigured = Boolean(env.ANTHROPIC_API_KEY);

/** Address verification and drive times need a Google Maps key. */
export const isMapsConfigured = Boolean(env.GOOGLE_MAPS_API_KEY);

export const isGmailConfigured = Boolean(
  env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REDIRECT_URI
);

/** Adam can call SantaCruz once it has somewhere to call and a key to call with. */
export const isSantaCruzOutboundConfigured = Boolean(env.SANTACRUZ_API_KEY);

/** SantaCruz can call Adam once a shared secret exists for it to present. */
export const isSantaCruzInboundConfigured = Boolean(env.SANTACRUZ_INBOUND_KEY);

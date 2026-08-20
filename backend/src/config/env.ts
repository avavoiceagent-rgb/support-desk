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

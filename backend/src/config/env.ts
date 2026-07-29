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
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:");
  console.error(parsed.error.flatten().fieldErrors);
  throw new Error("Invalid environment configuration. Check backend/.env against .env.example.");
}

export const env = parsed.data;

export const isGmailConfigured = Boolean(
  env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REDIRECT_URI
);

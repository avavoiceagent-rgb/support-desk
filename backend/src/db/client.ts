import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";
import { env } from "../config/env";

// Managed Postgres providers (Neon, Render, etc.) require TLS; local dev
// Postgres typically doesn't support it. Enable TLS whenever the connection
// string asks for it.
const needsSsl = /sslmode=require|neon\.tech|render\.com/.test(env.DATABASE_URL);

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
});

export const db = drizzle(pool, { schema });

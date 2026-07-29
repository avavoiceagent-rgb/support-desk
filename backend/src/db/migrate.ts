// One-shot migration runner: applies any pending SQL files in ../../drizzle
// against DATABASE_URL. Safe to run on every deploy/start.
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool } from "./client";
import path from "node:path";

async function main() {
  await migrate(db, { migrationsFolder: path.join(__dirname, "..", "..", "drizzle") });
  console.log("Migrations applied.");
  await pool.end();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});

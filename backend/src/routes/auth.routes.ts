import { Router } from "express";
import { z } from "zod";
import { eq, count } from "drizzle-orm";
import { db } from "../db/client";
import { users } from "../db/schema";
import { hashPassword, verifyPassword } from "../auth/password";
import { signSession, sessionCookieOptions, SESSION_COOKIE_NAME } from "../auth/jwt";
import { requireAuth } from "../middleware/auth";

export const authRouter = Router();

function publicUser(u: typeof users.$inferSelect) {
  return { id: u.id, email: u.email, name: u.name, role: u.role };
}

// GET /api/auth/setup-status — tells the frontend whether to show
// "create admin account" (no users yet) or the normal login screen.
authRouter.get("/setup-status", async (_req, res) => {
  const [{ value }] = await db.select({ value: count() }).from(users);
  res.json({ needsSetup: value === 0 });
});

// POST /api/auth/setup — one-time creation of the first (admin) user.
// Rejected once any user exists, so this can't be replayed later.
const setupSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

authRouter.post("/setup", async (req, res) => {
  const [{ value: existing }] = await db.select({ value: count() }).from(users);
  if (existing > 0) {
    return res.status(409).json({ error: "Setup already completed. Please log in." });
  }
  const parsed = setupSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
  }
  const { name, email, password } = parsed.data;
  const passwordHash = await hashPassword(password);
  const [user] = await db
    .insert(users)
    .values({ name, email: email.toLowerCase(), passwordHash, role: "ADMIN" })
    .returning();

  const token = signSession({ userId: user.id, role: user.role });
  res.cookie(SESSION_COOKIE_NAME, token, sessionCookieOptions);
  res.status(201).json({ user: publicUser(user) });
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

authRouter.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid email or password" });
  }
  const { email, password } = parsed.data;
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, email.toLowerCase()))
    .limit(1);

  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    return res.status(401).json({ error: "Invalid email or password" });
  }

  const token = signSession({ userId: user.id, role: user.role });
  res.cookie(SESSION_COOKIE_NAME, token, sessionCookieOptions);
  res.json({ user: publicUser(user) });
});

authRouter.post("/logout", (_req, res) => {
  res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
  res.status(204).end();
});

authRouter.get("/me", requireAuth, async (req, res) => {
  const [user] = await db.select().from(users).where(eq(users.id, req.session!.userId)).limit(1);
  if (!user) return res.status(401).json({ error: "Not authenticated" });
  res.json({ user: publicUser(user) });
});

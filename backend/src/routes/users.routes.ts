import { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { users } from "../db/schema";
import { hashPassword } from "../auth/password";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { param } from "../utils/params";

export const usersRouter = Router();
usersRouter.use(requireAuth);

function publicUser(u: typeof users.$inferSelect) {
  return { id: u.id, email: u.email, name: u.name, role: u.role };
}

// Any authenticated team member can see the roster (needed for assignment dropdowns).
usersRouter.get("/", async (_req, res) => {
  const all = await db.select().from(users).orderBy(users.name);
  res.json({ users: all.map(publicUser) });
});

const createUserSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
  role: z.enum(["ADMIN", "AGENT"]).default("AGENT"),
});

// Admin-only: invite a new team member (no self-signup / email verification for v1).
usersRouter.post("/", requireAdmin, async (req, res) => {
  const parsed = createUserSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
  }
  const { name, email, password, role } = parsed.data;
  const [existing] = await db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1);
  if (existing) {
    return res.status(409).json({ error: "A user with that email already exists" });
  }
  const passwordHash = await hashPassword(password);
  const [user] = await db
    .insert(users)
    .values({ name, email: email.toLowerCase(), passwordHash, role })
    .returning();
  res.status(201).json({ user: publicUser(user) });
});

const resetPasswordSchema = z.object({ password: z.string().min(8) });

// Admin-only: reset another team member's password (no email-based reset flow for v1).
usersRouter.post("/:id/reset-password", requireAdmin, async (req, res) => {
  const parsed = resetPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Password must be at least 8 characters" });
  }
  const passwordHash = await hashPassword(parsed.data.password);
  const [user] = await db
    .update(users)
    .set({ passwordHash, updatedAt: new Date() })
    .where(eq(users.id, param(req, "id")))
    .returning();
  if (!user) return res.status(404).json({ error: "User not found" });
  res.json({ user: publicUser(user) });
});

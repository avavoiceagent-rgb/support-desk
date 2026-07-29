import { Router } from "express";
import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { emailAccounts } from "../db/schema";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { encryptToken } from "../crypto/token-encryption";
import { getProvider } from "../mail/registry";
import { env, isGmailConfigured } from "../config/env";
import { pollAllAccounts } from "../mail/poller";
import { param } from "../utils/params";

export const emailAccountsRouter = Router();

// GET /api/email-accounts — status only, never returns tokens.
emailAccountsRouter.get("/", requireAuth, async (_req, res) => {
  const accounts = await db
    .select({
      id: emailAccounts.id,
      provider: emailAccounts.provider,
      email: emailAccounts.email,
      status: emailAccounts.status,
      lastError: emailAccounts.lastError,
      connectedAt: emailAccounts.connectedAt,
    })
    .from(emailAccounts);
  res.json({ accounts, gmailConfigured: isGmailConfigured });
});

// GET /api/email-accounts/gmail/connect — admin kicks off the OAuth flow.
emailAccountsRouter.get("/gmail/connect", requireAuth, requireAdmin, (req, res) => {
  if (!isGmailConfigured) {
    return res
      .status(400)
      .json({ error: "Gmail isn't configured yet. See docs/GOOGLE_OAUTH_SETUP.md and set the GOOGLE_* env vars." });
  }
  const state = jwt.sign({ purpose: "gmail-connect", userId: req.session!.userId }, env.JWT_SECRET, {
    expiresIn: "10m",
  });
  const provider = getProvider("GMAIL");
  res.json({ authUrl: provider.getAuthUrl(state) });
});

// GET /api/email-accounts/gmail/callback — Google redirects the browser
// here after the team member approves access. No JSON API response: this
// is a browser navigation, so we redirect back into the app with a status.
emailAccountsRouter.get("/gmail/callback", async (req, res) => {
  const redirectBase = `${env.APP_BASE_URL}/settings`;
  try {
    const { code, state } = req.query as { code?: string; state?: string };
    if (!code || !state) throw new Error("Missing code or state from Google");

    const decoded = jwt.verify(state, env.JWT_SECRET) as { purpose: string; userId: string };
    if (decoded.purpose !== "gmail-connect") throw new Error("Invalid state");

    const provider = getProvider("GMAIL");
    const { accountEmail, refreshToken } = await provider.handleOAuthCallback(code);
    const encrypted = encryptToken(refreshToken);

    await db
      .insert(emailAccounts)
      .values({
        provider: "GMAIL",
        email: accountEmail,
        encryptedRefreshToken: encrypted.ciphertext,
        tokenIv: encrypted.iv,
        tokenAuthTag: encrypted.authTag,
        status: "connected",
      })
      .onConflictDoUpdate({
        target: emailAccounts.email,
        set: {
          encryptedRefreshToken: encrypted.ciphertext,
          tokenIv: encrypted.iv,
          tokenAuthTag: encrypted.authTag,
          status: "connected",
          lastError: null,
          updatedAt: new Date(),
        },
      });

    void pollAllAccounts(); // kick off an immediate sync rather than waiting for the interval

    res.redirect(`${redirectBase}?status=success&email=${encodeURIComponent(accountEmail)}`);
  } catch (err) {
    console.error("[gmail-oauth] callback failed:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    res.redirect(`${redirectBase}?status=error&message=${encodeURIComponent(message)}`);
  }
});

// DELETE /api/email-accounts/:id — disconnect a mailbox.
emailAccountsRouter.delete("/:id", requireAuth, requireAdmin, async (req, res) => {
  await db.delete(emailAccounts).where(eq(emailAccounts.id, param(req, "id")));
  res.status(204).end();
});

// POST /api/email-accounts/poll-now — manual "check for new email" trigger.
emailAccountsRouter.post("/poll-now", requireAuth, async (_req, res) => {
  void pollAllAccounts();
  res.status(202).json({ triggered: true });
});

// GET /api/email-accounts/cron-poll?key=<CRON_SECRET> — unauthenticated
// poll trigger for external schedulers (keeps mail syncing on hosts where
// the app sleeps when idle). Requires CRON_SECRET to be configured; the
// poll itself runs in the background so this responds fast.
emailAccountsRouter.get("/cron-poll", async (req, res) => {
  if (!env.CRON_SECRET || req.query.key !== env.CRON_SECRET) {
    return res.status(404).end();
  }
  void pollAllAccounts();
  res.status(202).json({ triggered: true });
});

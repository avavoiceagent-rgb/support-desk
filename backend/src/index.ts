import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import path from "node:path";
import fs from "node:fs";
import { env } from "./config/env";
import { authRouter } from "./routes/auth.routes";
import { usersRouter } from "./routes/users.routes";
import { ticketsRouter } from "./routes/tickets.routes";
import { emailAccountsRouter } from "./routes/email-accounts.routes";
import { bookingRouter } from "./routes/booking.routes";
import { startMailPoller } from "./mail/poller";

const app = express();

app.use(express.json({ limit: "5mb" }));
app.use(cookieParser());

if (env.NODE_ENV !== "production") {
  // In prod the frontend is served from this same origin, so no CORS needed.
  app.use(cors({ origin: "http://localhost:5173", credentials: true }));
}

app.use("/api/auth", authRouter);
app.use("/api/users", usersRouter);
app.use("/api/tickets", ticketsRouter);
app.use("/api/email-accounts", emailAccountsRouter);
app.use("/api/booking", bookingRouter);

app.get("/api/health", (_req, res) => res.json({ ok: true }));

// Serve the built frontend as static files + SPA fallback, so this is a
// single deployable service (see plan: one process, one Railway service).
const frontendDist = path.join(__dirname, "..", "..", "frontend", "dist");
if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(path.join(frontendDist, "index.html"));
  });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[unhandled]", err);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(env.PORT, () => {
  console.log(`Ticketing backend listening on port ${env.PORT} (${env.NODE_ENV})`);
  startMailPoller();
});

import { Request, Response, NextFunction } from "express";
import { SESSION_COOKIE_NAME, verifySession, SessionPayload } from "../auth/jwt";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      session?: SessionPayload;
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.[SESSION_COOKIE_NAME];
  const session = token ? verifySession(token) : null;
  if (!session) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  req.session = session;
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.session?.role !== "ADMIN") {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
}

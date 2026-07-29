import jwt from "jsonwebtoken";
import { env } from "../config/env";

export interface SessionPayload {
  userId: string;
  role: "ADMIN" | "AGENT";
}

const EXPIRES_IN = "30d";

export function signSession(payload: SessionPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: EXPIRES_IN });
}

export function verifySession(token: string): SessionPayload | null {
  try {
    return jwt.verify(token, env.JWT_SECRET) as SessionPayload;
  } catch {
    return null;
  }
}

export const SESSION_COOKIE_NAME = "ticketing_session";

export const sessionCookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: env.NODE_ENV === "production",
  maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days, matches EXPIRES_IN
  path: "/",
};

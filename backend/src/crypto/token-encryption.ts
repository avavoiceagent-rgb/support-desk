// AES-256-GCM encryption for OAuth refresh tokens at rest.
// Uses a single master key from ENCRYPTION_KEY (32-byte, base64).
// See .env.example for generation instructions.

import crypto from "node:crypto";
import { env } from "../config/env";

function getKey(): Buffer {
  const key = Buffer.from(env.ENCRYPTION_KEY, "base64");
  if (key.length !== 32) {
    throw new Error(
      `ENCRYPTION_KEY must decode to exactly 32 bytes (got ${key.length}). Generate one with: openssl rand -base64 32`
    );
  }
  return key;
}

export interface EncryptedToken {
  ciphertext: string; // base64
  iv: string; // base64
  authTag: string; // base64
}

export function encryptToken(plaintext: string): EncryptedToken {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
  };
}

export function decryptToken(encrypted: EncryptedToken): string {
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    getKey(),
    Buffer.from(encrypted.iv, "base64")
  );
  decipher.setAuthTag(Buffer.from(encrypted.authTag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}

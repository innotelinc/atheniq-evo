/**
 * Passwords, sessions and cookies.
 *
 * - Passwords are stored as scrypt hashes with a per-password salt. A registrar
 *   bootstrap password may arrive as a hash (`REGISTRAR_PASSWORD_HASH`) so the
 *   environment never has to hold plaintext.
 * - Sessions are stateless HMAC-signed cookies, audience-separated by cookie
 *   name (`atheniq_student` vs `atheniq_staff`). A student cookie cannot be
 *   replayed as a staff cookie even though one process signs both.
 */

import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_BYTES = 64;
const MAXMEM = 64 * 1024 * 1024;

/** Compare two strings without leaking where they differ. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password.normalize("NFKC"), salt, KEY_BYTES, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: MAXMEM,
  });
  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("base64url"),
    hash.toString("base64url"),
  ].join("$");
}

/**
 * Verify a password against a stored hash. Returns false for a malformed hash
 * rather than throwing: a corrupt record must not take sign-in down.
 */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, salt, expected] = parts as [string, string, string, string, string, string];
  const cost = { N: Number(n), r: Number(r), p: Number(p), maxmem: MAXMEM };
  if (!Number.isFinite(cost.N) || !Number.isFinite(cost.r) || !Number.isFinite(cost.p)) return false;
  let actual: Buffer;
  try {
    actual = scryptSync(password.normalize("NFKC"), Buffer.from(salt, "base64url"), KEY_BYTES, cost);
  } catch {
    return false;
  }
  const wanted = Buffer.from(expected, "base64url");
  if (actual.length !== wanted.length) return false;
  return timingSafeEqual(actual, wanted);
}

/** A readable, high-entropy password a registrar hands over once. */
export function temporaryPassword(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = randomBytes(12);
  const chars = Array.from(bytes, (byte) => alphabet[byte % alphabet.length] as string);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4, 8).join("")}-${chars.slice(8, 12).join("")}`;
}

export type SessionRole = "student" | "registrar";

export interface SessionPayload {
  sub: string;
  role: SessionRole;
  /** Unix seconds. */
  exp: number;
}

export const SESSION_COOKIE = "atheniq_student";
export const STAFF_COOKIE = "atheniq_staff";
export const SESSION_TTL_SECONDS = 8 * 60 * 60;

function hmac(secret: string, value: string): Buffer {
  return createHmac("sha256", secret).update(value).digest();
}

export function signSession(payload: SessionPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = hmac(secret, body).toString("base64url");
  return `${body}.${signature}`;
}

export function verifySession(
  token: string,
  secret: string,
  role: SessionRole,
  now: Date = new Date(),
): SessionPayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, signature] = parts as [string, string];
  const expected = hmac(secret, body).toString("base64url");
  if (!safeEqual(signature, expected)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const claims = parsed as Record<string, unknown>;
  if (claims.role !== role) return null;
  if (typeof claims.sub !== "string" || !claims.sub) return null;
  if (typeof claims.exp !== "number" || claims.exp < Math.floor(now.getTime() / 1000)) return null;
  return { sub: claims.sub, role, exp: claims.exp };
}

export function sessionCookie(name: string, value: string, options: {
  secure: boolean;
  maxAgeSeconds: number;
}): string {
  const parts = [
    `${name}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${options.maxAgeSeconds}`,
  ];
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearCookie(name: string, secure: boolean): string {
  const parts = [`${name}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const pair of header.split(";")) {
    const index = pair.indexOf("=");
    if (index < 1) continue;
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (name) cookies[name] = decodeURIComponent(value);
  }
  return cookies;
}

/**
 * A small in-memory attempt limiter for sign-in. It is per process, which is
 * the right unit here: one institution, one process, and a restart must not
 * preserve a lockout.
 */
export class AttemptLimiter {
  private readonly attempts = new Map<string, { count: number; resetAt: number }>();
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(limit = 8, windowMs = 10 * 60 * 1000) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  /** Returns true when the attempt is allowed, and records it. */
  take(key: string, now: number = Date.now()): boolean {
    const entry = this.attempts.get(key);
    if (!entry || entry.resetAt <= now) {
      this.attempts.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.limit;
  }

  clear(key: string): void {
    this.attempts.delete(key);
  }
}

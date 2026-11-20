/**
 * Tokens and signatures.
 *
 * Two kinds of trust cross this service, and they never share a secret:
 *
 * - **Classroom tokens** (HS256 JWT) tell OpenMAIC who a learner is. They live
 *   15 minutes, are audience-pinned, and carry the course they were minted for.
 * - **Hook signatures** (HMAC-SHA256 over `timestamp.body`) tell the bridge
 *   that a completion callback really came from OpenMAIC.
 *
 * Both are implemented against `node:crypto`, so the bridge has no dependency
 * to install, pin or audit.
 */

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  ATHENIQ_CLASSROOM_AUDIENCE,
  ATHENIQ_ISSUER,
  CLASSROOM_ROLES,
  CONTRACT_VERSION,
  type AtheniqRole,
  type ClassroomClaims,
  type Validation,
} from "./contracts.ts";

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function hmac(secret: string, payload: string): Buffer {
  return createHmac("sha256", secret).update(payload).digest();
}

/** Compare two buffers without leaking where they differ. */
export function safeEqual(a: Buffer | string, b: Buffer | string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export interface MintClassroomTokenInput {
  learnerId: string;
  role?: AtheniqRole;
  name?: string;
  email?: string;
  org: string;
  courseKey: string;
  classroomId: string;
  lmsUsername?: string;
  ttlSeconds: number;
  now?: Date;
}

/** Build and sign a classroom token. */
export function signClassroomToken(
  input: MintClassroomTokenInput,
  secret: string,
): { token: string; claims: ClassroomClaims } {
  const issuedAt = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const claims: ClassroomClaims = {
    iss: ATHENIQ_ISSUER,
    aud: ATHENIQ_CLASSROOM_AUDIENCE,
    sub: input.learnerId,
    iat: issuedAt,
    exp: issuedAt + input.ttlSeconds,
    jti: randomUUID(),
    ver: CONTRACT_VERSION,
    role: input.role ?? "learner",
    org: input.org,
    courseKey: input.courseKey,
    classroomId: input.classroomId,
    ...(input.name ? { name: input.name } : {}),
    ...(input.email ? { email: input.email } : {}),
    ...(input.lmsUsername ? { lmsUsername: input.lmsUsername } : {}),
  };

  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64url(JSON.stringify(claims));
  const signature = base64url(hmac(secret, `${header}.${body}`));
  return { token: `${header}.${body}.${signature}`, claims };
}

const CLOCK_TOLERANCE_SECONDS = 30;
const ROLES = new Set<string>(["learner", "instructor", "registrar", "service"]);

function decodeJson(segment: string): unknown {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

/**
 * Verify a classroom token.
 *
 * Pins algorithm, issuer, audience, contract version and expiry. A token with
 * the right signature but the wrong audience is refused: an assertion minted
 * for another product must not open a classroom.
 */
export function verifyClassroomToken(
  token: string,
  secret: string,
  options: { now?: Date; audience?: string; issuer?: string } = {},
): Validation<ClassroomClaims> {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, error: "malformed token" };
  const [header, body, signature] = parts as [string, string, string];

  const head = decodeJson(header);
  if (typeof head !== "object" || head === null) return { ok: false, error: "malformed header" };
  if ((head as Record<string, unknown>).alg !== "HS256") return { ok: false, error: "unsupported alg" };

  const expected = base64url(hmac(secret, `${header}.${body}`));
  if (!safeEqual(signature, expected)) return { ok: false, error: "bad signature" };

  const payload = decodeJson(body);
  if (typeof payload !== "object" || payload === null) return { ok: false, error: "malformed payload" };
  const claims = payload as Record<string, unknown>;

  const now = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const audience = options.audience ?? ATHENIQ_CLASSROOM_AUDIENCE;
  const issuer = options.issuer ?? ATHENIQ_ISSUER;

  if (claims.iss !== issuer) return { ok: false, error: "wrong issuer" };
  if (claims.aud !== audience) return { ok: false, error: "wrong audience" };
  if (claims.ver !== CONTRACT_VERSION) return { ok: false, error: "unsupported contract version" };
  if (typeof claims.exp !== "number" || claims.exp + CLOCK_TOLERANCE_SECONDS < now) {
    return { ok: false, error: "token expired" };
  }
  if (typeof claims.sub !== "string" || !claims.sub) return { ok: false, error: "missing subject" };
  if (typeof claims.role !== "string" || !ROLES.has(claims.role)) {
    return { ok: false, error: "unknown role" };
  }
  if (typeof claims.courseKey !== "string" || !claims.courseKey) {
    return { ok: false, error: "missing course" };
  }
  if (typeof claims.classroomId !== "string" || !claims.classroomId) {
    return { ok: false, error: "missing classroom" };
  }
  if (typeof claims.org !== "string" || !claims.org) return { ok: false, error: "missing org" };

  return { ok: true, value: claims as unknown as ClassroomClaims };
}

/** The OpenMAIC-side role list for a signed claim, shared with the OpenMAIC patch. */
export function classroomRolesFor(role: AtheniqRole): readonly string[] {
  return CLASSROOM_ROLES[role];
}

/* ------------------------------------------------------------------ */
/* Completion hook signatures                                          */
/* ------------------------------------------------------------------ */

/** Replays older than this are refused, so a captured callback expires. */
export const HOOK_TOLERANCE_SECONDS = 300;

export function signHookBody(secret: string, timestamp: string, rawBody: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

export function verifyHookSignature(
  secret: string,
  headers: { signature: string | undefined; timestamp: string | undefined },
  rawBody: string,
  now: Date = new Date(),
): Validation<true> {
  const signature = headers.signature?.trim();
  const timestamp = headers.timestamp?.trim();
  if (!signature || !timestamp) return { ok: false, error: "missing signature headers" };
  if (!/^\d{1,12}$/.test(timestamp)) return { ok: false, error: "malformed timestamp" };

  const sentAt = Number.parseInt(timestamp, 10);
  const skew = Math.abs(Math.floor(now.getTime() / 1000) - sentAt);
  if (skew > HOOK_TOLERANCE_SECONDS) return { ok: false, error: "stale signature" };

  if (!safeEqual(signature, signHookBody(secret, timestamp, rawBody))) {
    return { ok: false, error: "bad signature" };
  }
  return { ok: true, value: true };
}

/**
 * The AthenIQ console, as the bridge uses it.
 *
 * The console owns the academic record and the award center, and it is the only
 * thing that talks to Signara. The bridge therefore asks the console to close an
 * enrollment and to issue a credential, instead of re-implementing eligibility,
 * PDF rendering and the three-call Signara dance a second time. One issuer of
 * record, one place to change it.
 *
 * The console exposes these two operations on one service-authenticated route
 * (`/api/internal/atheniq`), added by the console patch in `patches/`.
 */

import { call, type Fetcher } from "../http.ts";
import type { StepResult } from "../contracts.ts";

export interface ConsoleOptions {
  baseUrl: string;
  token: string;
  fetcher?: Fetcher;
  timeoutMs?: number;
}

export interface ConsoleCompletionResult {
  step: StepResult;
  eligible: string[];
  detail: string;
}

function authenticated(options: ConsoleOptions): Record<string, string> {
  return { authorization: `Bearer ${options.token}` };
}

function notConfigured(step: StepResult["step"]): ConsoleCompletionResult {
  return {
    step: { step, status: "not_configured", detail: "CONSOLE_BASE_URL / CONSOLE_SERVICE_TOKEN are not configured." },
    eligible: [],
    detail: "console not configured",
  };
}

/**
 * Close the learner's enrollment in the console with the classroom's grade.
 *
 * The console is authoritative for whether the completion makes the learner
 * eligible for a track or degree, so its answer is carried back verbatim
 * instead of being recomputed here.
 */
export async function completeEnrollment(
  options: ConsoleOptions,
  input: {
    learnerId: string;
    courseKey: string;
    grade: string;
    completedOn: string;
    source: string;
    outcomes: { id: string; label: string; mastery?: number }[];
  },
): Promise<ConsoleCompletionResult> {
  if (!options.baseUrl || !options.token) return notConfigured("console-completion");

  const result = await call({
    baseUrl: options.baseUrl,
    path: "/api/internal/atheniq",
    method: "POST",
    headers: authenticated(options),
    body: { action: "complete-enrollment", ...input },
    fetcher: options.fetcher,
    timeoutMs: options.timeoutMs,
  });

  const data = (result.body?.data ?? null) as Record<string, unknown> | null;
  const eligible = Array.isArray(data?.eligible)
    ? (data.eligible as unknown[]).filter((item): item is string => typeof item === "string")
    : [];

  return {
    step: {
      step: "console-completion",
      status: result.ok ? "ok" : "failed",
      detail: result.ok
        ? `Enrollment closed in the console${eligible.length ? `; eligible for ${eligible.join(", ")}` : ""}.`
        : `Console refused the completion: ${result.error ?? `HTTP ${result.status}`} ${result.text}`.trim(),
      http: result.status,
      ...(eligible.length ? { eligible } : {}),
    },
    eligible,
    detail: result.ok ? "ok" : (result.error ?? `HTTP ${result.status}`),
  };
}

export interface ConsoleCredentialResult {
  step: StepResult;
  credential: { credentialId: string; verifyId: string; status: string } | null;
  detail: string;
}

/**
 * Ask the console to issue and sign a credential.
 *
 * The console renders the PDF, runs the Signara upload → signing request →
 * typed signature flow, and returns the award it recorded. A `queued_local`
 * status is a real outcome: the award exists and is waiting for a Signara key,
 * so it is reported as `ok` with the reason in the detail rather than as a
 * failure the caller should retry forever.
 */
export async function issueCredential(
  options: ConsoleOptions,
  input: {
    learnerId: string;
    type: string;
    subjectRef: string;
    grade?: string;
    completedOn?: string;
    credits?: number;
    gpa?: string;
    override?: boolean;
    autoSign?: boolean;
    idempotencyKey?: string;
  },
): Promise<ConsoleCredentialResult> {
  if (!options.baseUrl || !options.token) {
    return {
      step: { step: "credential", status: "not_configured", detail: "Console is not configured." },
      credential: null,
      detail: "console not configured",
    };
  }

  const result = await call({
    baseUrl: options.baseUrl,
    path: "/api/internal/atheniq",
    method: "POST",
    headers: { ...authenticated(options), ...(input.idempotencyKey ? { "x-idempotency-key": input.idempotencyKey } : {}) },
    body: { action: "issue-credential", ...input },
    fetcher: options.fetcher,
    timeoutMs: options.timeoutMs ?? 120_000,
  });

  const data = (result.body?.data ?? null) as Record<string, unknown> | null;
  const credentialId = typeof data?.credentialId === "string" ? data.credentialId : null;
  const verifyId = typeof data?.verifyId === "string" ? data.verifyId : null;
  const status = typeof data?.status === "string" ? data.status : "unknown";

  if (!result.ok || !credentialId || !verifyId) {
    return {
      step: {
        step: "credential",
        status: "failed",
        detail: `Console refused the award: ${result.error ?? `HTTP ${result.status}`} ${result.text}`.trim(),
        http: result.status,
      },
      credential: null,
      detail: result.error ?? `HTTP ${result.status}`,
    };
  }

  return {
    step: {
      step: "credential",
      status: "ok",
      detail: `Award ${verifyId} recorded (${status}).`,
      http: result.status,
    },
    credential: { credentialId, verifyId, status },
    detail: status,
  };
}

export async function probeConsole(
  options: ConsoleOptions,
): Promise<{ status: "ok" | "failed" | "not_configured"; detail: string }> {
  if (!options.baseUrl) return { status: "not_configured", detail: "CONSOLE_BASE_URL is not set." };
  const result = await call({
    baseUrl: options.baseUrl,
    path: "/api/health",
    fetcher: options.fetcher,
    timeoutMs: options.timeoutMs,
  });
  if (result.status === 0) return { status: "failed", detail: result.error ?? "unreachable" };
  if (result.status >= 500) return { status: "failed", detail: `Console answered HTTP ${result.status}.` };
  return { status: "ok", detail: `Console reachable (HTTP ${result.status}).` };
}

/**
 * OpenMAIC, as the bridge uses it.
 *
 * One call: start a classroom generation job for the course requirement, as the
 * learner the classroom belongs to. The bearer token is a bridge-minted
 * classroom token, so OpenMAIC resolves the same `sub` the learner has
 * everywhere else — there is no parallel account to keep in step.
 *
 * `POST /api/generate-classroom` answers `202` with the job; generation then
 * runs in the OpenMAIC process and survives the browser. The bridge records
 * whatever identifier the job carries so a completion can be tied back to it.
 */

import { call, type Fetcher } from "../http.ts";

export interface OpenMaicOptions {
  baseUrl: string;
  fetcher?: Fetcher;
  timeoutMs?: number;
}

const MAX_BODY_BYTES_HINT = 4000;

export interface StartClassroomResult {
  ok: boolean;
  jobId: string | null;
  stageId: string | null;
  status: number;
  error: string | null;
  body: Record<string, unknown> | null;
}

/**
 * Start a generation job.
 *
 * The requirement is trimmed to the generator's own limit rather than being
 * refused here: a long course description is legitimate material, and the
 * generator decides what it can use.
 */
export async function startClassroom(
  options: OpenMaicOptions,
  input: { token: string; requirement: string; materialIds?: string[] },
): Promise<StartClassroomResult> {
  const requirement = input.requirement.trim().slice(0, MAX_BODY_BYTES_HINT);
  const body: Record<string, unknown> = { requirement };
  if (input.materialIds?.length) body.materialIds = input.materialIds;

  const result = await call({
    baseUrl: options.baseUrl,
    path: "/api/generate-classroom",
    method: "POST",
    headers: { authorization: `Bearer ${input.token}` },
    body,
    fetcher: options.fetcher,
    timeoutMs: options.timeoutMs ?? 30_000,
  });

  const payload = result.body;
  // The job view has changed shape across releases; accept the known keys in
  // order rather than assuming one, and never fail a started job over it.
  const data = (payload?.data ?? payload) as Record<string, unknown> | null;
  const jobId =
    pickString(data, "id") ?? pickString(data, "jobId") ?? pickString(data, "runId") ?? null;
  const stageId = pickString(data, "stageId") ?? pickString(data, "classroomId") ?? null;

  return {
    ok: result.ok,
    jobId,
    stageId,
    status: result.status,
    error: result.ok ? null : `${result.error ?? `HTTP ${result.status}`} ${result.text}`.trim(),
    body: data,
  };
}

function pickString(data: Record<string, unknown> | null, key: string): string | null {
  const value = data?.[key];
  return typeof value === "string" && value ? value : null;
}

export async function probeOpenMaic(
  options: OpenMaicOptions,
): Promise<{ status: "ok" | "failed" | "not_configured"; detail: string }> {
  if (!options.baseUrl) return { status: "not_configured", detail: "OPENMAIC_BASE_URL is not set." };
  const result = await call({
    baseUrl: options.baseUrl,
    path: "/api/health",
    fetcher: options.fetcher,
    timeoutMs: options.timeoutMs,
  });
  if (result.status === 0) return { status: "failed", detail: result.error ?? "unreachable" };
  if (result.status >= 500) return { status: "failed", detail: `OpenMAIC answered HTTP ${result.status}.` };
  return { status: "ok", detail: `OpenMAIC reachable (HTTP ${result.status}).` };
}

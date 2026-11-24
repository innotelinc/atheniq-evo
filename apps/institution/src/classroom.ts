/**
 * The AI classroom, as the console uses it.
 *
 * The bridge owns the launch flow and signs the classroom token; this module
 * asks it and hands the browser a cookie. Embedding needs two origins that the
 * browser treats as one site — the console and OpenMAIC under the same parent
 * domain, or the same host on another port in development — so the iframe can
 * carry the HttpOnly classroom cookie without the token ever reaching page
 * JavaScript.
 *
 * Everything here is optional. Without a bridge URL, the course editor says the
 * classroom is not connected instead of rendering an empty frame.
 */

import type { InstitutionConfig } from "./config.ts";
import type { CatalogCourse } from "./catalog.ts";

/** The class preview belongs to the registrar, not to a student. */
export const PREVIEW_LEARNER = "stf_registrar";

export interface ClassroomRef {
  classroomId: string;
  stageId: string | null;
  jobId: string;
  createdAt: string;
}

export interface StartResult {
  ok: boolean;
  note: string;
  classroom?: ClassroomRef;
  launchUrl: string | null;
}

export interface SignInResult {
  ok: boolean;
  note: string;
  token: string | null;
  /** Where the iframe (or a redirect) should point. */
  url: string | null;
}

function bridgeReady(config: InstitutionConfig): string | null {
  if (!config.bridgeUrl) return "ATHENIQ_BRIDGE_URL is not set.";
  if (!config.bridgeToken) return "ATHENIQ_BRIDGE_SERVICE_TOKEN is not set.";
  return null;
}

export function stageFrom(url: string | null): string | null {
  if (!url) return null;
  const match = /\/classroom\/([^/?#]+)/.exec(url);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function requirementFor(course: CatalogCourse): string {
  const outcomes = course.outcomes.length > 0 ? ` Outcomes: ${course.outcomes.join("; ")}.` : "";
  return `${course.code} ${course.title}: ${course.summary}.${outcomes}`.slice(0, 3_900);
}

/**
 * Start (or reuse) a classroom for this course.
 *
 * A course keeps one preview classroom. Regenerating on every page load would
 * leave a library of near-identical rooms and a ledger full of abandoned ones.
 */
export async function startClassroom(
  config: InstitutionConfig,
  course: CatalogCourse,
  fetcher: typeof fetch = fetch,
): Promise<StartResult> {
  const missing = bridgeReady(config);
  if (missing) return { ok: false, note: `The bridge is not configured: ${missing}`, launchUrl: null };

  try {
    const response = await fetcher(`${config.bridgeUrl}/v1/classrooms`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.bridgeToken}`,
        "x-atheniq-actor": "institution-console",
      },
      body: JSON.stringify({
        courseKey: course.key,
        learnerId: PREVIEW_LEARNER,
        name: "Registrar preview",
        email: config.registrarEmail,
        requirement: requirementFor(course),
      }),
      signal: AbortSignal.timeout(35_000),
    });
    const text = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        note: `The bridge refused the classroom (HTTP ${response.status}): ${text.slice(0, 300)}`,
        launchUrl: null,
      };
    }
    const body = JSON.parse(text) as { classroomId?: string; jobId?: string; launchUrl?: string };
    if (!body.classroomId) {
      return { ok: false, note: "The bridge accepted the request but returned no classroom.", launchUrl: null };
    }
    return {
      ok: true,
      note: "OpenMAIC accepted the generation job. The classroom fills in as it is written.",
      classroom: {
        classroomId: body.classroomId,
        stageId: stageFrom(body.launchUrl ?? null),
        jobId: body.jobId ?? "",
        createdAt: new Date().toISOString(),
      },
      launchUrl: body.launchUrl ?? null,
    };
  } catch (error) {
    return {
      ok: false,
      note: `The bridge is unreachable (${error instanceof Error ? error.message : String(error)}).`,
      launchUrl: null,
    };
  }
}

/** A fresh 15-minute classroom token for this course's preview room. */
export async function signInToClassroom(
  config: InstitutionConfig,
  course: CatalogCourse,
  fetcher: typeof fetch = fetch,
): Promise<SignInResult> {
  const missing = bridgeReady(config);
  if (missing) return { ok: false, note: `The bridge is not configured: ${missing}`, token: null, url: null };

  try {
    const response = await fetcher(`${config.bridgeUrl}/v1/sso/classroom`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.bridgeToken}`,
      },
      body: JSON.stringify({
        learnerId: PREVIEW_LEARNER,
        name: "Registrar preview",
        email: config.registrarEmail,
        courseKey: course.key,
        role: "instructor",
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        note: `The bridge refused the classroom sign-in (HTTP ${response.status}): ${text.slice(0, 300)}`,
        token: null,
        url: null,
      };
    }
    const body = JSON.parse(text) as { token?: string; classroomUrl?: string };
    if (!body.token) {
      return { ok: false, note: "The bridge returned no classroom token.", token: null, url: null };
    }
    const stage = course.classroom?.stageId ?? null;
    const base = (config.openmaicPublicUrl || "").replace(/\/+$/, "");
    return {
      ok: true,
      note: "",
      token: body.token,
      url: base && stage ? `${base}/classroom/${encodeURIComponent(stage)}` : body.classroomUrl ?? null,
    };
  } catch (error) {
    return {
      ok: false,
      note: `The bridge is unreachable (${error instanceof Error ? error.message : String(error)}).`,
      token: null,
      url: null,
    };
  }
}

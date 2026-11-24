/**
 * The LMS catalog, read-only.
 *
 * The console edits the Institute's catalog and the LMS serves courseware. The
 * one fact the console cannot know is whether a course is actually live at
 * `atheniq.courses` right now, so it asks the public catalog endpoint — the same
 * one the console uses, which needs no token. Every failure is reported, never
 * thrown: a restarting LMS must not stop the registrar drawing a page.
 */

import type { InstitutionConfig } from "./config.ts";

export interface LmsCourse {
  code: string;
  title: string;
  key: string;
}

export interface LmsCatalogResult {
  ok: boolean;
  courses: LmsCourse[];
  error: string | null;
}

const PAGE_SIZE = 100;

/** Snapshot rows from the LMS catalog response, without trusting its shape. */
function rows(payload: unknown): { code: string; title: string; key: string }[] {
  if (typeof payload !== "object" || payload === null) return [];
  const results = (payload as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];
  const courses: { code: string; title: string; key: string }[] = [];
  for (const item of results) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const key = typeof record.id === "string" ? record.id : "";
    const name = typeof record.name === "string" ? record.name : "";
    const number =
      typeof record.number === "string" && record.number
        ? record.number
        : /^course-v1:[^+]+\+([^+]+)\+/.exec(key)?.[1] ?? "";
    const code = number.trim().toUpperCase();
    if (!code || !key) continue;
    const title = name.replace(new RegExp(`^${code}\\s*[—–-]\\s*`, "i"), "").trim() || name || code;
    courses.push({ code, title, key });
  }
  return courses;
}

export async function fetchLmsCatalog(
  config: InstitutionConfig,
  fetcher: typeof fetch = fetch,
): Promise<LmsCatalogResult> {
  if (!config.lmsBaseUrl) {
    return {
      ok: false,
      courses: [],
      error: "LMS_BASE_URL is not set, so the LMS catalog cannot be read.",
    };
  }
  try {
    const response = await fetcher(
      `${config.lmsBaseUrl.replace(/\/+$/, "")}/api/courses/v1/courses/?page_size=${PAGE_SIZE}`,
      { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8_000) },
    );
    if (!response.ok) {
      return {
        ok: false,
        courses: [],
        error: `The LMS catalog answered HTTP ${response.status}.`,
      };
    }
    const courses = rows(await response.json());
    return {
      ok: true,
      courses,
      error: courses.length === 0 ? "The LMS answered, but served no courses." : null,
    };
  } catch (error) {
    return {
      ok: false,
      courses: [],
      error: `The LMS catalog is unreachable (${error instanceof Error ? error.message : String(error)}).`,
    };
  }
}

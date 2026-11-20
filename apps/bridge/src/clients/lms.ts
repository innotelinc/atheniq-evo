/**
 * Open edX, as the bridge uses it.
 *
 * Two writes matter, and they have different requirements — a fact the LMS's
 * REST surface forces, not a design choice:
 *
 * - **Completion** (`POST /api/completion/v1/completion-batch`) addresses the
 *   learner by *username*. Documented body:
 *   `{ username, course_key, blocks: { "<block key>": 1.0 } }`.
 * - **Grade override** (`POST /api/grades/v1/gradebook/{course}/bulk-update`)
 *   addresses the learner by *numeric user id*, and Open edX does not expose
 *   that id over REST. So the bridge needs a mapping, and refuses to guess: a
 *   grade written to the wrong user is worse than an unwritten one.
 *
 * When no id is known the grade step reports `not_configured` with the reason,
 * and the completion still lands. That is deliberate: the learner's progress is
 * never lost because one optional step is missing.
 */

import { call, type Fetcher, type UpstreamResult } from "../http.ts";
import type { StepResult } from "../contracts.ts";

export interface LmsOptions {
  baseUrl: string;
  token: string;
  gradeUsageId: string;
  fetcher?: Fetcher;
  timeoutMs?: number;
  /** AthenIQ learner id → Open edX numeric user id. */
  userMap?: Record<string, number>;
  /** Username → numeric user id, captured once at enrollment sync. */
  usernameMap?: Record<string, number>;
}

function configured(options: LmsOptions): boolean {
  return Boolean(options.baseUrl && options.token);
}

function auth(options: LmsOptions): Record<string, string> {
  return { authorization: `Bearer ${options.token}` };
}

/** The LMS usage id a completion is written to, or an empty string. */
export function completionBlockKey(options: LmsOptions): string {
  return options.gradeUsageId;
}

/**
 * Mark the AI-classroom block complete in the LMS.
 *
 * `blocks` maps a block key to its completion value (1.0 = complete). The
 * bridge writes the whole course's grade alongside it so the LMS's own
 * progress and gradebook agree with what the classroom observed.
 */
export async function writeCompletion(
  options: LmsOptions,
  input: { courseKey: string; username: string; blockKey?: string; score?: number; maxScore?: number },
): Promise<UpstreamResult> {
  const blockKey = input.blockKey || completionBlockKey(options);
  const blocks: Record<string, number> = { [blockKey]: 1.0 };
  const body: Record<string, unknown> = {
    username: input.username,
    course_key: input.courseKey,
    blocks,
  };
  if (input.score !== undefined && input.maxScore !== undefined && input.maxScore > 0) {
    body.earned = input.score;
    body.possible = input.maxScore;
  }
  return call({
    baseUrl: options.baseUrl,
    path: "/api/completion/v1/completion-batch",
    method: "POST",
    headers: auth(options),
    body,
    fetcher: options.fetcher,
    timeoutMs: options.timeoutMs,
  });
}

/** Resolve the numeric id a gradebook override needs, from the maps the host supplied. */
export function resolveUserId(
  options: LmsOptions,
  learnerId: string,
  username: string | undefined,
): number | null {
  const byLearner = options.userMap?.[learnerId];
  if (typeof byLearner === "number" && Number.isFinite(byLearner)) return byLearner;
  if (username) {
    const byName = options.usernameMap?.[username];
    if (typeof byName === "number" && Number.isFinite(byName)) return byName;
  }
  return null;
}

/**
 * Write the classroom's score as a subsection grade override.
 *
 * `earned_*`/`possible_*` are raw points for the subsection; the LMS recomputes
 * the course grade from the course policy, so the bridge never fabricates a
 * percentage where the policy should decide.
 */
export async function writeGrade(
  options: LmsOptions,
  input: {
    courseKey: string;
    userId: number;
    usageId?: string;
    score: number;
    maxScore: number;
    comment: string;
  },
): Promise<UpstreamResult> {
  const usageId = input.usageId || options.gradeUsageId;
  return call({
    baseUrl: options.baseUrl,
    path: `/api/grades/v1/gradebook/${encodeURIComponent(input.courseKey)}/bulk-update`,
    method: "POST",
    headers: auth(options),
    body: [
      {
        user_id: input.userId,
        usage_id: usageId,
        grade: {
          earned_all_override: input.score,
          possible_all_override: input.maxScore,
          earned_graded_override: input.score,
          possible_graded_override: input.maxScore,
          comment: input.comment,
        },
      },
    ],
    fetcher: options.fetcher,
    timeoutMs: options.timeoutMs,
  });
}

export interface LmsWriteInput {
  courseKey: string;
  learnerId: string;
  username?: string;
  score?: number;
  maxScore?: number;
  comment: string;
}

function notConfiguredStep(step: StepResult["step"], detail: string): StepResult {
  return { step, status: "not_configured", detail };
}

/**
 * Mark the AI-classroom block complete in the LMS.
 *
 * Separate from the grade on purpose: the two are distinct calls, so a retry
 * after a missing token can re-run one without writing the other twice.
 */
export async function lmsCompletionStep(
  options: LmsOptions,
  input: LmsWriteInput,
): Promise<StepResult> {
  if (!configured(options)) {
    return notConfiguredStep(
      "lms-completion",
      options.baseUrl ? "LMS_API_TOKEN is not configured." : "LMS_BASE_URL is not configured.",
    );
  }
  if (!input.username) {
    return {
      step: "lms-completion",
      status: "skipped",
      detail: "No LMS username for this learner; completion was not written.",
    };
  }

  const completion = await writeCompletion(options, {
    courseKey: input.courseKey,
    username: input.username,
    score: input.score,
    maxScore: input.maxScore,
  });

  return {
    step: "lms-completion",
    status: completion.ok ? "ok" : "failed",
    detail: completion.ok
      ? `Completion written for ${input.username} in ${input.courseKey}.`
      : `LMS refused the completion: ${completion.error ?? `HTTP ${completion.status}`} ${completion.text}`.trim(),
    http: completion.status,
  };
}

/** Write the classroom's score as a subsection grade override, when it is possible. */
export async function lmsGradeStep(options: LmsOptions, input: LmsWriteInput): Promise<StepResult> {
  if (!configured(options)) {
    return notConfiguredStep(
      "lms-grade",
      options.baseUrl ? "LMS_API_TOKEN is not configured." : "LMS_BASE_URL is not configured.",
    );
  }
  if (!options.gradeUsageId) {
    return notConfiguredStep(
      "lms-grade",
      "LMS_GRADE_USAGE_ID is not set, so there is no graded block to score.",
    );
  }
  if (input.score === undefined || input.maxScore === undefined || input.maxScore <= 0) {
    return {
      step: "lms-grade",
      status: "skipped",
      detail: "The classroom reported no score, so no grade override was written.",
    };
  }
  if (!input.username) {
    return { step: "lms-grade", status: "skipped", detail: "No LMS username for this learner." };
  }

  const userId = resolveUserId(options, input.learnerId, input.username);
  if (userId === null) {
    return notConfiguredStep(
      "lms-grade",
      "Open edX does not expose numeric user ids over REST; add this learner to LMS_USER_MAP_PATH to enable grade overrides.",
    );
  }

  const grade = await writeGrade(options, {
    courseKey: input.courseKey,
    userId,
    usageId: options.gradeUsageId,
    score: input.score,
    maxScore: input.maxScore,
    comment: input.comment,
  });

  return {
    step: "lms-grade",
    status: grade.ok ? "ok" : "failed",
    detail: grade.ok
      ? `Grade override ${input.score}/${input.maxScore} written for user ${userId}.`
      : `LMS refused the grade: ${grade.error ?? `HTTP ${grade.status}`} ${grade.text}`.trim(),
    http: grade.status,
  };
}

/** Both LMS writes, in order. */
export async function recordCompletion(
  options: LmsOptions,
  input: LmsWriteInput,
): Promise<StepResult[]> {
  return [await lmsCompletionStep(options, input), await lmsGradeStep(options, input)];
}

export async function probeLms(options: LmsOptions): Promise<{ status: "ok" | "failed" | "not_configured"; detail: string }> {
  if (!options.baseUrl) return { status: "not_configured", detail: "LMS_BASE_URL is not set." };
  const result = await call({
    baseUrl: options.baseUrl,
    path: "/api/courses/v1/courses/?page_size=1",
    fetcher: options.fetcher,
    timeoutMs: options.timeoutMs,
  });
  if (result.status === 0) return { status: "failed", detail: result.error ?? "unreachable" };
  if (result.status >= 500) return { status: "failed", detail: `LMS answered HTTP ${result.status}.` };
  return { status: "ok", detail: `LMS reachable (HTTP ${result.status}).` };
}

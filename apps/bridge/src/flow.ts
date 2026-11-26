/**
 * The flows that cross system boundaries.
 *
 * Two of them matter:
 *
 * 1. **Launch** — mint a classroom token and start a classroom in OpenMAIC for
 *    a course the learner is enrolled in. The console asks for this; the
 *    learner's browser is then redirected straight into the classroom.
 * 2. **Complete** — accept a classroom's completion callback once, write it to
 *    the LMS, close the enrollment in the console, and award a credential when
 *    the console says the learner is eligible.
 *
 * Everything is idempotent by `classroomId:learnerId` (or an explicit caller
 * key), because a callback retried after a timeout must not award a second
 * certificate. A retry re-runs only the steps that did not finish.
 */

import { createHash } from "node:crypto";
import {
  gradeOf,
  type CompletionRequest,
  type CompletionResponse,
  type CreateClassroomRequest,
  type CreateClassroomResponse,
  type IssueCredentialRequest,
  type IssueCredentialResponse,
  type SsoClassroomRequest,
  type SsoClassroomResponse,
  type StepResult,
  type TranscriptEntry,
} from "./contracts.ts";
import { signClassroomToken } from "./auth.ts";
import type { Config } from "./config.ts";
import {
  LedgerStore,
  newId,
  type ClassroomRecord,
  type CompletionRecord,
  type RetryState,
} from "./ledger.ts";
import { lmsCompletionStep, lmsGradeStep } from "./clients/lms.ts";
import { startClassroom } from "./clients/openmaic.ts";
import { completeEnrollment, issueCredential } from "./clients/console.ts";
import type { Fetcher } from "./http.ts";

export class FlowError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface FlowDeps {
  config: Config;
  ledger: LedgerStore;
  fetcher?: Fetcher;
  now?: () => Date;
  /** AthenIQ learner id → Open edX numeric user id. */
  lmsUserMap?: Record<string, number>;
  /** Open edX username → numeric user id. */
  lmsUsernameMap?: Record<string, number>;
  /** Where a completion that stays partial raises its one alert. */
  alert?: (line: string) => void;
}

function clock(deps: FlowDeps): Date {
  return (deps.now ?? (() => new Date()))();
}

function classroomUrl(config: Config, stageId: string | null): string {
  const base = config.openmaic.baseUrl.replace(/\/+$/, "");
  // The generator names the stage it created; when it does not, the learner
  // lands on their own library, where the classroom appears under this owner.
  return stageId ? `${base}/classroom/${encodeURIComponent(stageId)}` : `${base}/`;
}

function mintFor(
  deps: FlowDeps,
  classroom: ClassroomRecord,
  input: { role?: "learner" | "instructor"; name?: string; email?: string },
): string {
  return signClassroomToken(
    {
      learnerId: classroom.learnerId,
      role: input.role ?? "learner",
      org: deps.config.org,
      courseKey: classroom.courseKey,
      classroomId: classroom.id,
      ttlSeconds: deps.config.tokenTtlSeconds,
      now: clock(deps),
      ...(input.name ? { name: input.name } : {}),
      ...(input.email ? { email: input.email } : {}),
      ...(classroom.lmsUsername ? { lmsUsername: classroom.lmsUsername } : {}),
    },
    deps.config.jwtSecret,
  ).token;
}

/**
 * Start a classroom and remember it.
 *
 * OpenMAIC is called before the record is written, so a failed start leaves no
 * half-created classroom for a completion to attach to.
 */
export async function createClassroom(
  deps: FlowDeps,
  input: CreateClassroomRequest,
  actor: string,
): Promise<CreateClassroomResponse> {
  const classroomId = newId("cls");
  const token = signClassroomToken(
    {
      learnerId: input.learnerId,
      role: "learner",
      org: deps.config.org,
      courseKey: input.courseKey,
      classroomId,
      ttlSeconds: deps.config.tokenTtlSeconds,
      now: clock(deps),
      ...(input.name ? { name: input.name } : {}),
      ...(input.email ? { email: input.email } : {}),
      ...(input.lmsUsername ? { lmsUsername: input.lmsUsername } : {}),
    },
    deps.config.jwtSecret,
  ).token;

  const started = await startClassroom(
    { baseUrl: deps.config.openmaic.baseUrl, fetcher: deps.fetcher, timeoutMs: 30_000 },
    { token, requirement: input.requirement, materialIds: input.materialIds },
  );

  if (!started.ok) {
    throw new FlowError(
      502,
      "OPENMAIC_START_FAILED",
      `OpenMAIC refused the classroom: ${started.error ?? `HTTP ${started.status}`}`,
    );
  }

  const createdAt = clock(deps).toISOString();
  const record: ClassroomRecord = {
    id: classroomId,
    courseKey: input.courseKey,
    learnerId: input.learnerId,
    jobId: started.jobId ?? "",
    requirement: input.requirement,
    createdAt,
    createdBy: actor,
    ...(input.lmsUsername ? { lmsUsername: input.lmsUsername } : {}),
  };

  await deps.ledger.update((data) => {
    data.classrooms.push(record);
    deps.ledger.recordEvent(
      data,
      "classroom.created",
      classroomId,
      `${input.learnerId} started a classroom for ${input.courseKey}${started.jobId ? ` (job ${started.jobId})` : ""}.`,
      clock(deps),
    );
  });

  return {
    classroomId,
    courseKey: input.courseKey,
    jobId: started.jobId ?? "",
    launchUrl: classroomUrl(deps.config, started.stageId),
    token,
    expiresIn: deps.config.tokenTtlSeconds,
    createdAt,
  };
}

/**
 * Sign a learner into a classroom for a course.
 *
 * Re-entering a course returns to the same room: a learner who opens their
 * course twice must not end up with two libraries of duplicate work.
 */
export async function ssoClassroom(
  deps: FlowDeps,
  input: SsoClassroomRequest,
): Promise<SsoClassroomResponse> {
  const existing = deps.ledger
    .snapshot()
    .classrooms.filter((item) => item.learnerId === input.learnerId && item.courseKey === input.courseKey)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

  const classroom: ClassroomRecord = existing ?? {
    id: newId("cls"),
    courseKey: input.courseKey,
    learnerId: input.learnerId,
    jobId: "",
    requirement: "",
    createdAt: clock(deps).toISOString(),
    createdBy: "sso",
    ...(input.lmsUsername ? { lmsUsername: input.lmsUsername } : {}),
  };

  if (!existing) {
    await deps.ledger.update((data) => {
      data.classrooms.push(classroom);
      deps.ledger.recordEvent(
        data,
        "classroom.reserved",
        classroom.id,
        `${input.learnerId} opened ${input.courseKey} before generation.`,
        clock(deps),
      );
    });
  }

  const token = mintFor(deps, classroom, {
    role: input.role === "instructor" ? "instructor" : "learner",
    name: input.name,
    email: input.email,
  });

  return {
    token,
    expiresIn: deps.config.tokenTtlSeconds,
    classroomId: classroom.id,
    courseKey: classroom.courseKey,
    classroomUrl: classroomUrl(deps.config, null),
  };
}

function idempotencyKeyFor(input: CompletionRequest): string {
  if (input.idempotencyKey) return input.idempotencyKey;
  return `auto:${createHash("sha256")
    .update(`${input.classroomId}:${input.learnerId}:${input.courseKey}`)
    .digest("hex")
    .slice(0, 32)}`;
}

function gradeLabel(percent: number | null): string {
  return percent === null ? "Pass" : `${percent}%`;
}

/** A step is finished when the last run either succeeded or was not applicable. */
function isFinished(step: StepResult | undefined): boolean {
  return step?.status === "ok" || step?.status === "skipped";
}

function finalStatus(steps: StepResult[]): CompletionRecord["status"] {
  if (steps.some((step) => step.status === "failed" || step.status === "not_configured")) return "partial";
  return "complete";
}

interface StepRun {
  steps: StepResult[];
  credential: CompletionRecord["credential"];
}

/**
 * Run the fan-out for one completion.
 *
 * `reuseFinished` is what makes a retry useful: a completion whose grade failed
 * because a token was missing keeps its completion, and only the failed step
 * runs again. The order is fixed and observable — LMS, console, credential —
 * because the console is the authority on eligibility and the credential must
 * never precede it.
 */
async function runSteps(
  deps: FlowDeps,
  record: CompletionRecord,
  reuseFinished: boolean,
): Promise<StepRun> {
  const prior = new Map(record.steps.map((step) => [step.step, step]));
  const steps: StepResult[] = [];
  let credential = record.credential;
  const percent = record.grade?.percent ?? null;

  /* 1. The LMS: completion first, then any grade override — each reusable alone. */
  const lmsOptions = {
    baseUrl: deps.config.lms.baseUrl,
    token: deps.config.lms.token,
    gradeUsageId: deps.config.lms.gradeUsageId,
    fetcher: deps.fetcher,
    userMap: deps.lmsUserMap,
    usernameMap: deps.lmsUsernameMap,
  };
  const lmsInput = {
    courseKey: record.courseKey,
    learnerId: record.learnerId,
    username: record.lmsUsername,
    score: record.score,
    maxScore: record.maxScore,
    comment: `AthenIQ classroom ${record.classroomId}: ${gradeLabel(percent)}`,
  };

  const completionPrior = prior.get("lms-completion");
  steps.push(
    reuseFinished && isFinished(completionPrior)
      ? (completionPrior as StepResult)
      : await lmsCompletionStep(lmsOptions, lmsInput),
  );

  const gradePrior = prior.get("lms-grade");
  steps.push(
    reuseFinished && isFinished(gradePrior) ? (gradePrior as StepResult) : await lmsGradeStep(lmsOptions, lmsInput),
  );

  /* 2. The console: close the enrollment, and learn what it made eligible. */
  const consolePrior = prior.get("console-completion");
  let eligible: string[] = consolePrior?.eligible ?? [];
  if (reuseFinished && isFinished(consolePrior)) {
    steps.push(consolePrior as StepResult);
  } else {
    const closed = await completeEnrollment(
      { baseUrl: deps.config.console.baseUrl, token: deps.config.console.token, fetcher: deps.fetcher },
      {
        learnerId: record.learnerId,
        courseKey: record.courseKey,
        grade: gradeLabel(percent),
        completedOn: record.completedAt.slice(0, 10),
        source: `openmaic:${record.classroomId}`,
        outcomes: record.outcomes,
      },
    );
    steps.push(closed.step);
    eligible = closed.eligible;
  }

  /* 3. The credential, only on request, only after a closed enrollment. */
  const consoleStep = steps.find((step) => step.step === "console-completion");
  const credentialPrior = prior.get("credential");

  if (credential) {
    steps.push(
      credentialPrior ??
        ({
          step: "credential",
          status: "ok",
          detail: `Award ${credential.verifyId} was issued earlier (${credential.status}).`,
        } satisfies StepResult),
    );
  } else if (reuseFinished && isFinished(credentialPrior)) {
    steps.push(credentialPrior as StepResult);
  } else if (!record.issueCredential) {
    steps.push({
      step: "credential",
      status: "skipped",
      detail: "No credential was requested for this completion.",
    });
  } else if (consoleStep?.status !== "ok") {
    steps.push({
      step: "credential",
      status: "skipped",
      detail: "The enrollment is not closed in the console, so no credential was awarded.",
    });
  } else if (!eligible.includes(record.courseKey)) {
    steps.push({
      step: "credential",
      status: "skipped",
      detail: "The console reported the learner is not yet eligible for a course certificate.",
    });
  } else {
    const awarded = await issueCredential(
      { baseUrl: deps.config.console.baseUrl, token: deps.config.console.token, fetcher: deps.fetcher },
      {
        learnerId: record.learnerId,
        type: "course_certificate",
        subjectRef: record.courseKey,
        grade: gradeLabel(percent),
        completedOn: record.completedAt.slice(0, 10),
        autoSign: true,
        idempotencyKey: `credential:${record.id}`,
      },
    );
    steps.push(awarded.step);
    if (awarded.credential) credential = awarded.credential;
  }

  return {
    steps: steps.filter((step): step is StepResult => Boolean(step)),
    credential,
  };
}

const retrying = new Set<string>();

function initialRetry(now: Date, config: Config): RetryState {
  return {
    attempts: 0,
    nextAttemptAt: new Date(now.getTime() + config.retry.baseMs).toISOString(),
  };
}

/** Schedule the next automatic attempt, doubling the delay up to the cap. */
function nextRetry(record: CompletionRecord, now: Date, config: Config, error?: string): RetryState {
  const attempts = (record.retry?.attempts ?? 0) + 1;
  const delay = Math.min(config.retry.baseMs * 2 ** Math.min(attempts - 1, 16), config.retry.maxMs);
  return {
    attempts,
    nextAttemptAt: new Date(now.getTime() + delay).toISOString(),
    lastAttemptAt: now.toISOString(),
    ...(error ? { lastError: error } : {}),
    ...(record.retry?.alertedAt ? { alertedAt: record.retry.alertedAt } : {}),
  };
}

/**
 * Re-run the unfinished steps of one partial completion.
 *
 * Used by `?retry=1` and by the scheduled sweep, so both paths share the same
 * idempotent step reuse and the same backoff bookkeeping. A completion that is
 * already complete is returned untouched.
 */
export async function retryCompletion(deps: FlowDeps, completionId: string): Promise<CompletionRecord> {
  const existing = deps.ledger.snapshot().completions.find((item) => item.id === completionId);
  if (!existing) throw new FlowError(404, "NOT_FOUND", "No such completion.");
  if (existing.status !== "partial" || retrying.has(existing.id)) return existing;

  retrying.add(existing.id);
  const now = clock(deps);
  try {
    const rerun = await runSteps(deps, existing, true);
    const status = finalStatus(rerun.steps);
    const stale = now.getTime() - Date.parse(existing.receivedAt) >= deps.config.retry.alertAfterMs;
    const shouldAlert = status === "partial" && stale && !existing.retry?.alertedAt;

    const updated = await deps.ledger.update((data) => {
      const record = data.completions.find((item) => item.id === existing.id);
      if (!record) return existing;
      record.steps = rerun.steps;
      record.credential = rerun.credential;
      record.status = status;
      if (status === "complete") {
        delete record.retry;
      } else {
        record.retry = nextRetry(existing, now, deps.config);
        if (shouldAlert && record.retry) record.retry.alertedAt = now.toISOString();
      }
      deps.ledger.recordEvent(data, "completion.retried", record.id, `Retry finished as ${status}.`, now);
      return structuredClone(record);
    });

    if (shouldAlert) {
      deps.alert?.(
        `completion ${updated.id} (${updated.learnerId}, ${updated.courseKey}) has been partial since ${updated.receivedAt} and is still undelivered after ${updated.retry?.attempts ?? 0} retries`,
      );
    }
    return updated;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await deps.ledger.update((data) => {
      const record = data.completions.find((item) => item.id === existing.id);
      if (!record) return;
      record.retry = nextRetry(record, now, deps.config, message);
      deps.ledger.recordEvent(data, "completion.retry-failed", record.id, message, now);
    });
    throw error;
  } finally {
    retrying.delete(existing.id);
  }
}

/** Accept one completion. */
export async function completeClassroom(
  deps: FlowDeps,
  input: CompletionRequest,
  options: { retry: boolean },
): Promise<CompletionResponse> {
  const key = idempotencyKeyFor(input);
  const existing = deps.ledger.snapshot().completions.find((item) => item.idempotencyKey === key);

  if (existing) {
    if (!options.retry) return toResponse(existing, true);
    return toResponse(await retryCompletion(deps, existing.id), true);
  }

  const classroom = deps.ledger.snapshot().classrooms.find((item) => item.id === input.classroomId);
  if (!classroom) {
    throw new FlowError(409, "UNKNOWN_CLASSROOM", "This classroom was not launched through the bridge.");
  }
  if (classroom.courseKey !== input.courseKey) {
    throw new FlowError(409, "COURSE_MISMATCH", "The completion names a different course than the classroom.");
  }
  if (classroom.learnerId !== input.learnerId) {
    throw new FlowError(409, "LEARNER_MISMATCH", "The completion names a different learner than the classroom.");
  }

  const grade = gradeOf(input.score, input.maxScore);
  const record: CompletionRecord = {
    id: newId("cmp"),
    idempotencyKey: key,
    classroomId: input.classroomId,
    courseKey: input.courseKey,
    learnerId: input.learnerId,
    ...(input.lmsUsername ?? classroom.lmsUsername
      ? { lmsUsername: input.lmsUsername ?? classroom.lmsUsername }
      : {}),
    ...(input.score !== undefined ? { score: input.score } : {}),
    ...(input.maxScore !== undefined ? { maxScore: input.maxScore } : {}),
    grade,
    outcomes: input.outcomes ?? [],
    completedAt: input.completedAt ?? clock(deps).toISOString(),
    receivedAt: clock(deps).toISOString(),
    steps: [],
    credential: null,
    status: "pending",
    issueCredential: input.issueCredential === true,
  };

  // Reserve the key before any network call: a concurrent duplicate must lose
  // here, not after it has already awarded a certificate.
  await deps.ledger.update((data) => {
    data.completions.push(structuredClone(record));
    deps.ledger.recordEvent(
      data,
      "completion.received",
      record.id,
      `${input.learnerId} finished ${input.courseKey} (${gradeLabel(grade?.percent ?? null)}).`,
      clock(deps),
    );
  });

  const ran = await runSteps(deps, record, false);

  const stored = await deps.ledger.update((data) => {
    const item = data.completions.find((entry) => entry.id === record.id);
    if (!item) return record;
    const status = finalStatus(ran.steps);
    item.steps = ran.steps;
    item.credential = ran.credential;
    item.status = status;
    if (status === "partial") item.retry = initialRetry(clock(deps), deps.config);
    if (ran.credential) {
      data.credentials.push({
        id: newId("crd"),
        idempotencyKey: `credential:${item.id}`,
        learnerId: item.learnerId,
        type: "course_certificate",
        subjectRef: item.courseKey,
        credentialId: ran.credential.credentialId,
        verifyId: ran.credential.verifyId,
        status: ran.credential.status,
        createdAt: clock(deps).toISOString(),
      });
      deps.ledger.recordEvent(
        data,
        "credential.issued",
        item.id,
        `${ran.credential.verifyId} (${ran.credential.status}).`,
        clock(deps),
      );
    }
    deps.ledger.recordEvent(data, "completion.fanned-out", item.id, `Steps finished as ${item.status}.`, clock(deps));
    return structuredClone(item);
  });

  return toResponse(stored, false);
}

function toResponse(record: CompletionRecord, replay: boolean): CompletionResponse {
  return {
    completionId: record.id,
    replay,
    accepted: true,
    learnerId: record.learnerId,
    courseKey: record.courseKey,
    grade: record.grade,
    steps: record.steps,
    credential: record.credential,
    createdAt: record.receivedAt,
  };
}

/** Ask the console for one credential outside a completion (registrar action). */
export async function awardCredential(
  deps: FlowDeps,
  input: IssueCredentialRequest,
): Promise<IssueCredentialResponse> {
  const key = input.idempotencyKey ?? `manual:${input.learnerId}:${input.type}:${input.subjectRef}`;
  const existing = deps.ledger.snapshot().credentials.find((item) => item.idempotencyKey === key);
  if (existing) {
    return {
      credentialId: existing.credentialId,
      verifyId: existing.verifyId,
      status: existing.status,
      signara: { documentId: null, requestId: null, lastHttp: null, lastError: null },
    };
  }

  const awarded = await issueCredential(
    { baseUrl: deps.config.console.baseUrl, token: deps.config.console.token, fetcher: deps.fetcher },
    {
      learnerId: input.learnerId,
      type: input.type,
      subjectRef: input.subjectRef,
      grade: input.grade,
      completedOn: input.completedOn,
      credits: input.credits,
      gpa: input.gpa,
      override: input.override,
      autoSign: input.autoSign,
      idempotencyKey: key,
    },
  );

  const credential = awarded.credential;
  if (!credential) throw new FlowError(502, "CREDENTIAL_FAILED", awarded.step.detail);

  await deps.ledger.update((data) => {
    data.credentials.push({
      id: newId("crd"),
      idempotencyKey: key,
      learnerId: input.learnerId,
      type: input.type,
      subjectRef: input.subjectRef,
      credentialId: credential.credentialId,
      verifyId: credential.verifyId,
      status: credential.status,
      createdAt: clock(deps).toISOString(),
    });
    deps.ledger.recordEvent(
      data,
      "credential.issued",
      input.learnerId,
      `${input.type} for ${input.subjectRef}: ${credential.verifyId}.`,
      clock(deps),
    );
  });

  return {
    credentialId: credential.credentialId,
    verifyId: credential.verifyId,
    status: credential.status,
    signara: { documentId: null, requestId: null, lastHttp: awarded.step.http ?? null, lastError: null },
  };
}

/** A learner's AI-instruction record, newest first. */
export function transcript(deps: FlowDeps, learnerId: string): TranscriptEntry[] {
  return deps.ledger
    .snapshot()
    .completions.filter((item) => item.learnerId === learnerId)
    .sort((a, b) => b.completedAt.localeCompare(a.completedAt))
    .map((item) => ({
      completionId: item.id,
      courseKey: item.courseKey,
      completedAt: item.completedAt,
      grade: item.grade,
      outcomes: item.outcomes,
      credential: item.credential,
    }));
}

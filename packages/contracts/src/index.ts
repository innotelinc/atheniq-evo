/**
 * AthenIQ Evo — the integration contract.
 *
 * This file is the single definition of what crosses a system boundary:
 *
 *   console (portal)  --service call-->  bridge  --signed JWT-->  OpenMAIC
 *   OpenMAIC          --signed hook-->   bridge  --REST------->  Open edX LMS
 *   bridge            --service call-->  console --REST------->  Signara
 *
 * Nothing here imports a runtime. Any of the four repos can copy this file
 * verbatim (the console patch and the OpenMAIC patch do) and stay in step,
 * because every shape is versioned and every validator is total.
 */

/** Version of the wire contract. Bump on any breaking change; the bridge refuses older majors. */
export const CONTRACT_VERSION = 1 as const;

/** Issuer of the classroom token. OpenMAIC pins it and rejects anything else. */
export const ATHENIQ_ISSUER = "https://bridge.atheniq.institute";

/** Audience of the classroom token. A token minted for another app is not accepted. */
export const ATHENIQ_CLASSROOM_AUDIENCE = "atheniq-classroom";

/** Cookie OpenMAIC's host identity method reads. HttpOnly, set by the console's launch route. */
export const CLASSROOM_COOKIE = "atheniq_classroom";

/** Header OpenMAIC uses to sign completion callbacks to the bridge. */
export const HOOK_SIGNATURE_HEADER = "x-atheniq-signature";
export const HOOK_TIMESTAMP_HEADER = "x-atheniq-timestamp";

/**
 * What a person is in the estate.
 *
 * `learner` and `instructor` are course-scoped. `registrar` may award. `service`
 * is a machine principal and is never handed to a browser.
 */
export type AtheniqRole = "learner" | "instructor" | "registrar" | "service";

/** Roles OpenMAIC grants to the classroom owner, derived from {@link AtheniqRole}. */
export const CLASSROOM_ROLES: Record<AtheniqRole, readonly string[]> = {
  learner: ["course:read"],
  instructor: ["course:read", "course:publish"],
  registrar: ["course:read", "course:publish", "admin"],
  service: ["course:read", "course:publish", "admin"],
};

/**
 * The signed classroom claim set.
 *
 * `sub` is the AthenIQ person id (`lrn_…` for a learner, `stf_…` for staff) and is
 * the only identity OpenMAIC ever stores. Email is display data and may change;
 * `sub` may not.
 */
export interface ClassroomClaims {
  iss: string;
  aud: string;
  sub: string;
  iat: number;
  exp: number;
  jti: string;
  /** AthenIQ contract version, so a rolling deploy can refuse a stale token. */
  ver: number;
  role: AtheniqRole;
  name?: string;
  email?: string;
  /** Institution / white-label tenant. */
  org: string;
  /** The LMS course key this classroom serves, e.g. `course-v1:InnotelLabs+CS101+2026F`. */
  courseKey: string;
  /** The bridge's classroom record id, known before the classroom itself exists. */
  classroomId: string;
  /** LMS username, when the learner already has one, so grading needs no lookup. */
  lmsUsername?: string;
}

/** Every service-to-service call carries this instead of a person's credentials. */
export const SERVICE_TOKEN_HEADER = "authorization";

/* ------------------------------------------------------------------ */
/* Requests and responses                                              */
/* ------------------------------------------------------------------ */

export interface SsoClassroomRequest {
  learnerId: string;
  name: string;
  email: string;
  courseKey: string;
  lmsUsername?: string;
  role?: AtheniqRole;
}

export interface SsoClassroomResponse {
  token: string;
  expiresIn: number;
  classroomId: string;
  courseKey: string;
  /** Absolute URL of the classroom, ready to redirect the browser to. */
  classroomUrl: string;
}

export interface CreateClassroomRequest {
  courseKey: string;
  learnerId: string;
  lmsUsername?: string;
  name?: string;
  email?: string;
  /** The instructional objective handed to OpenMAIC's generator. */
  requirement: string;
  materialIds?: string[];
}

export interface CreateClassroomResponse {
  classroomId: string;
  courseKey: string;
  jobId: string;
  launchUrl: string;
  token: string;
  expiresIn: number;
  createdAt: string;
}

/** One learning outcome the AI classroom observed, reported as evidence. */
export interface OutcomeObservation {
  id: string;
  label: string;
  /** 0..1. Omitted when the classroom cannot measure it. */
  mastery?: number;
}

export interface CompletionRequest {
  /** The bridge classroom id. Required: it binds the event to a launch. */
  classroomId: string;
  courseKey: string;
  learnerId: string;
  lmsUsername?: string;
  /** Points earned in the classroom's own assessment. */
  score?: number;
  maxScore?: number;
  outcomes?: OutcomeObservation[];
  /** ISO instant. Defaults to the bridge's clock, never the caller's. */
  completedAt?: string;
  /** Ask the bridge to award a course certificate when the learner is eligible. */
  issueCredential?: boolean;
  /** Optional caller idempotency key; the bridge derives one when absent. */
  idempotencyKey?: string;
}

export type StepStatus = "ok" | "skipped" | "failed" | "not_configured";

export interface StepResult {
  step: "lms-grade" | "lms-completion" | "console-completion" | "credential";
  status: StepStatus;
  detail: string;
  /** HTTP status when the step made a call. */
  http?: number;
  /** Set by the console when the completion made the learner eligible. */
  eligible?: string[];
}

export interface CompletionResponse {
  completionId: string;
  /** True when this exact event had already been processed. */
  replay: boolean;
  accepted: boolean;
  learnerId: string;
  courseKey: string;
  grade: { earned: number; possible: number; percent: number } | null;
  steps: StepResult[];
  credential: { credentialId: string; verifyId: string; status: string } | null;
  createdAt: string;
}

export interface IssueCredentialRequest {
  learnerId: string;
  type: "course_certificate" | "track_credential" | "degree_conferral";
  /** Course key, track id or program id. */
  subjectRef: string;
  grade?: string;
  completedOn?: string;
  credits?: number;
  gpa?: string;
  /** Registrar override of the eligibility check. Recorded on the award. */
  override?: boolean;
  autoSign?: boolean;
  idempotencyKey?: string;
}

export interface IssueCredentialResponse {
  credentialId: string;
  verifyId: string;
  status: string;
  signara: {
    documentId: string | null;
    requestId: string | null;
    lastHttp: number | null;
    lastError: string | null;
  };
}

export interface TranscriptEntry {
  completionId: string;
  courseKey: string;
  completedAt: string;
  grade: { earned: number; possible: number; percent: number } | null;
  outcomes: OutcomeObservation[];
  credential: { credentialId: string; verifyId: string; status: string } | null;
}

export interface HealthResponse {
  ok: boolean;
  contract: number;
  service: string;
  uptimeSeconds: number;
  checks: { name: string; status: "ok" | "degraded" | "failed" | "not_configured"; detail: string }[];
  /** Completions still waiting for delivery; `stale` means past the alert window. */
  retries: { count: number; stale: number; oldestAgeSeconds: number };
}

/* ------------------------------------------------------------------ */
/* Validation — total, dependency-free, no surprises on the wire       */
/* ------------------------------------------------------------------ */

export type Validation<T> = { ok: true; value: T } | { ok: false; error: string };

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown, field: string, max = 512): Validation<string> {
  if (typeof value !== "string") return { ok: false, error: `${field} must be a string` };
  const trimmed = value.trim();
  if (!trimmed) return { ok: false, error: `${field} must not be empty` };
  if (trimmed.length > max) return { ok: false, error: `${field} must be at most ${max} characters` };
  return { ok: true, value: trimmed };
}

/** A string that is safe to use as an identifier in a URL, header or database key. */
function identifier(value: unknown, field: string): Validation<string> {
  const parsed = text(value, field, 256);
  if (!parsed.ok) return parsed;
  if (!/^[A-Za-z0-9._:@+-]+$/.test(parsed.value)) {
    return { ok: false, error: `${field} must match [A-Za-z0-9._:@+-]` };
  }
  return parsed;
}

/**
 * An Open edX course key.
 *
 * Both the modern `course-v1:Org+Course+Run` and the legacy `Org/Course/Run`
 * shapes are accepted, because an estate mid-migration has both and the LMS
 * rejects neither.
 */
export function isCourseKey(value: string): boolean {
  if (value.startsWith("course-v1:")) {
    // Exactly three segments: org, course and run.
    return /^course-v1:[^+\s]+(\+[^+\s]+){2}$/.test(value);
  }
  return /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(value);
}

export function parseCourseKey(value: unknown): Validation<string> {
  const parsed = text(value, "courseKey", 256);
  if (!parsed.ok) return parsed;
  if (!isCourseKey(parsed.value)) {
    return { ok: false, error: "courseKey must look like course-v1:Org+Course+Run" };
  }
  return parsed;
}

function optionalNumber(value: unknown, field: string): Validation<number | undefined> {
  if (value === undefined || value === null) return { ok: true, value: undefined };
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return { ok: false, error: `${field} must be a finite number >= 0` };
  }
  return { ok: true, value };
}

function optionalText(value: unknown, field: string, max = 512): Validation<string | undefined> {
  if (value === undefined || value === null || value === "") return { ok: true, value: undefined };
  return text(value, field, max);
}

function optionalStringArray(value: unknown, field: string): Validation<string[] | undefined> {
  if (value === undefined || value === null) return { ok: true, value: undefined };
  if (!Array.isArray(value)) return { ok: false, error: `${field} must be an array of strings` };
  const out: string[] = [];
  for (const item of value) {
    const parsed = identifier(item, `${field}[]`);
    if (!parsed.ok) return parsed;
    out.push(parsed.value);
  }
  return { ok: true, value: out };
}

export function parseSsoClassroomRequest(body: unknown): Validation<SsoClassroomRequest> {
  const obj = record(body);
  if (!obj) return { ok: false, error: "body must be a JSON object" };
  const learnerId = identifier(obj.learnerId, "learnerId");
  if (!learnerId.ok) return learnerId;
  const name = optionalText(obj.name, "name", 200);
  if (!name.ok) return name;
  const email = optionalText(obj.email, "email", 320);
  if (!email.ok) return email;
  const courseKey = parseCourseKey(obj.courseKey);
  if (!courseKey.ok) return courseKey;
  const lmsUsername = optionalText(obj.lmsUsername, "lmsUsername", 150);
  if (!lmsUsername.ok) return lmsUsername;
  const role = obj.role;
  if (role !== undefined && role !== "learner" && role !== "instructor") {
    return { ok: false, error: "role must be learner or instructor" };
  }
  return {
    ok: true,
    value: {
      learnerId: learnerId.value,
      name: name.value ?? learnerId.value,
      email: email.value ?? "",
      courseKey: courseKey.value,
      lmsUsername: lmsUsername.value,
      role: role ?? "learner",
    },
  };
}

export function parseCreateClassroomRequest(body: unknown): Validation<CreateClassroomRequest> {
  const obj = record(body);
  if (!obj) return { ok: false, error: "body must be a JSON object" };
  const courseKey = parseCourseKey(obj.courseKey);
  if (!courseKey.ok) return courseKey;
  const learnerId = identifier(obj.learnerId, "learnerId");
  if (!learnerId.ok) return learnerId;
  const requirement = text(obj.requirement, "requirement", 4000);
  if (!requirement.ok) return requirement;
  const lmsUsername = optionalText(obj.lmsUsername, "lmsUsername", 150);
  if (!lmsUsername.ok) return lmsUsername;
  const name = optionalText(obj.name, "name", 200);
  if (!name.ok) return name;
  const email = optionalText(obj.email, "email", 320);
  if (!email.ok) return email;
  const materialIds = optionalStringArray(obj.materialIds, "materialIds");
  if (!materialIds.ok) return materialIds;
  return {
    ok: true,
    value: {
      courseKey: courseKey.value,
      learnerId: learnerId.value,
      lmsUsername: lmsUsername.value,
      name: name.value,
      email: email.value,
      requirement: requirement.value,
      materialIds: materialIds.value,
    },
  };
}

const OUTCOME_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function parseCompletionRequest(body: unknown): Validation<CompletionRequest> {
  const obj = record(body);
  if (!obj) return { ok: false, error: "body must be a JSON object" };
  const classroomId = identifier(obj.classroomId, "classroomId");
  if (!classroomId.ok) return classroomId;
  const courseKey = parseCourseKey(obj.courseKey);
  if (!courseKey.ok) return courseKey;
  const learnerId = identifier(obj.learnerId, "learnerId");
  if (!learnerId.ok) return learnerId;
  const lmsUsername = optionalText(obj.lmsUsername, "lmsUsername", 150);
  if (!lmsUsername.ok) return lmsUsername;
  const score = optionalNumber(obj.score, "score");
  if (!score.ok) return score;
  const maxScore = optionalNumber(obj.maxScore, "maxScore");
  if (!maxScore.ok) return maxScore;
  if (score.value !== undefined && maxScore.value !== undefined && score.value > maxScore.value) {
    return { ok: false, error: "score must not exceed maxScore" };
  }

  let outcomes: OutcomeObservation[] | undefined;
  if (obj.outcomes !== undefined) {
    if (!Array.isArray(obj.outcomes)) return { ok: false, error: "outcomes must be an array" };
    const parsed: OutcomeObservation[] = [];
    for (const item of obj.outcomes) {
      const entry = record(item);
      if (!entry) return { ok: false, error: "each outcome must be an object" };
      const id = text(entry.id, "outcomes[].id", 128);
      if (!id.ok) return id;
      if (!OUTCOME_ID.test(id.value)) return { ok: false, error: "outcomes[].id is not a safe id" };
      const label = optionalText(entry.label, "outcomes[].label", 300);
      if (!label.ok) return label;
      const mastery = optionalNumber(entry.mastery, "outcomes[].mastery");
      if (!mastery.ok) return mastery;
      if (mastery.value !== undefined && mastery.value > 1) {
        return { ok: false, error: "outcomes[].mastery must be between 0 and 1" };
      }
      parsed.push({ id: id.value, label: label.value ?? id.value, mastery: mastery.value });
    }
    outcomes = parsed.slice(0, 100);
  }

  let completedAt: string | undefined;
  if (obj.completedAt !== undefined) {
    const parsed = text(obj.completedAt, "completedAt", 40);
    if (!parsed.ok) return parsed;
    const at = Date.parse(parsed.value);
    if (!Number.isFinite(at)) return { ok: false, error: "completedAt must be an ISO instant" };
    completedAt = new Date(at).toISOString();
  }

  const idempotencyKey = optionalText(obj.idempotencyKey, "idempotencyKey", 200);
  if (!idempotencyKey.ok) return idempotencyKey;

  return {
    ok: true,
    value: {
      classroomId: classroomId.value,
      courseKey: courseKey.value,
      learnerId: learnerId.value,
      lmsUsername: lmsUsername.value,
      score: score.value,
      maxScore: maxScore.value,
      outcomes,
      completedAt,
      issueCredential: obj.issueCredential === true,
      idempotencyKey: idempotencyKey.value,
    },
  };
}

export function parseIssueCredentialRequest(body: unknown): Validation<IssueCredentialRequest> {
  const obj = record(body);
  if (!obj) return { ok: false, error: "body must be a JSON object" };
  const learnerId = identifier(obj.learnerId, "learnerId");
  if (!learnerId.ok) return learnerId;
  const type = obj.type;
  if (type !== "course_certificate" && type !== "track_credential" && type !== "degree_conferral") {
    return { ok: false, error: "type must be a course_certificate, track_credential or degree_conferral" };
  }
  const subjectRef = text(obj.subjectRef, "subjectRef", 256);
  if (!subjectRef.ok) return subjectRef;
  const grade = optionalText(obj.grade, "grade", 32);
  if (!grade.ok) return grade;
  const completedOn = optionalText(obj.completedOn, "completedOn", 40);
  if (!completedOn.ok) return completedOn;
  const credits = optionalNumber(obj.credits, "credits");
  if (!credits.ok) return credits;
  const gpa = optionalText(obj.gpa, "gpa", 16);
  if (!gpa.ok) return gpa;
  const idempotencyKey = optionalText(obj.idempotencyKey, "idempotencyKey", 200);
  if (!idempotencyKey.ok) return idempotencyKey;
  return {
    ok: true,
    value: {
      learnerId: learnerId.value,
      type,
      subjectRef: subjectRef.value,
      grade: grade.value,
      completedOn: completedOn.value,
      credits: credits.value,
      gpa: gpa.value,
      override: obj.override === true,
      autoSign: obj.autoSign === true,
      idempotencyKey: idempotencyKey.value,
    },
  };
}

/** A 0..100 percentage, rounded to one decimal, for the grade passed to the LMS. */
export function percentOf(score: number | undefined, maxScore: number | undefined): number | null {
  if (score === undefined || maxScore === undefined || maxScore <= 0) return null;
  return Math.round((score / maxScore) * 1000) / 10;
}

/** The grade the LMS and the certificate both use, or null when the classroom measured nothing. */
export function gradeOf(
  score: number | undefined,
  maxScore: number | undefined,
): { earned: number; possible: number; percent: number } | null {
  if (score === undefined || maxScore === undefined || maxScore <= 0) return null;
  return { earned: score, possible: maxScore, percent: percentOf(score, maxScore) ?? 0 };
}

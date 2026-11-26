/**
 * The bridge's whole configuration surface, in one place.
 *
 * Nothing else reads `process.env`. A missing or weak secret stops the process
 * at boot with one line naming the variable, because a bridge that starts with
 * an empty signing key is worse than one that refuses to start: it would mint
 * classroom tokens anyone can forge.
 */

export interface UpstreamConfig {
  baseUrl: string;
  token: string;
}

export interface LmsConfig extends UpstreamConfig {
  /** The `usage_id` the AI-classroom grade is written to, e.g. a graded sequential. */
  gradeUsageId: string;
  /** Resolve a username to the numeric id the gradebook API needs. */
  accountLookup: boolean;
}

export interface OmniRouteConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface RetryConfig {
  /** The in-process sweep is off when false; `?retry=1` still works. */
  enabled: boolean;
  /** How often the sweep looks for due records. */
  intervalMs: number;
  /** First retry delay; doubles per attempt up to `maxMs`. */
  baseMs: number;
  maxMs: number;
  /** How long a completion may stay partial before it is reported as stale. */
  alertAfterMs: number;
}

export interface Config {
  port: number;
  origin: string;
  org: string;
  jwtSecret: string;
  serviceToken: string;
  hookSecret: string;
  dataDir: string;
  tokenTtlSeconds: number;
  classroomCookieDomain: string;
  openmaic: UpstreamConfig;
  lms: LmsConfig;
  console: UpstreamConfig;
  omniroute: OmniRouteConfig;
  /** Seconds a probe may take before it is reported as failed. */
  probeTimeoutMs: number;
  retry: RetryConfig;
}

export class ConfigError extends Error {}

function read(env: NodeJS.ProcessEnv, name: string, fallback = ""): string {
  const value = env[name];
  return (value ?? fallback).trim();
}

function required(env: NodeJS.ProcessEnv, name: string, minLength: number): string {
  const value = read(env, name);
  if (!value) throw new ConfigError(`${name} is required`);
  if (value.length < minLength) {
    throw new ConfigError(`${name} must be at least ${minLength} characters`);
  }
  return value;
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, allowZero = false): number {
  const raw = read(env, name);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < (allowZero ? 0 : 1)) {
    throw new ConfigError(`${name} must be a ${allowZero ? "non-negative" : "positive"} integer`);
  }
  return parsed;
}

function url(env: NodeJS.ProcessEnv, name: string, fallback = ""): string {
  const value = read(env, name, fallback);
  if (!value) return "";
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigError(`${name} must be an absolute http(s) URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ConfigError(`${name} must be an absolute http(s) URL`);
  }
  return parsed.toString().replace(/\/+$/, "");
}

const COURSE_USAGE_ID = /^block-v1:[^+\s]+\+[^+\s]+\+[^+\s]+\+type@[a-z+]+@[^+\s]+$/;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const origin = url(env, "BRIDGE_ORIGIN", "http://localhost:8787");
  const gradeUsageId = read(env, "LMS_GRADE_USAGE_ID");
  if (gradeUsageId && !COURSE_USAGE_ID.test(gradeUsageId)) {
    throw new ConfigError("LMS_GRADE_USAGE_ID must be an Open edX usage id (block-v1:…+type@…+block@…)");
  }

  return {
    // 0 is legitimate: it asks the OS for an ephemeral port, which is what the
    // test suite does so two suites never collide.
    port: integer(env, "PORT", 8787, true),
    origin,
    org: read(env, "ATHENIQ_ORG", "AthenIQ Institute"),
    // 32 bytes of entropy is the floor for an HS256 key; less is guessable.
    jwtSecret: required(env, "BRIDGE_JWT_SECRET", 32),
    serviceToken: required(env, "BRIDGE_SERVICE_TOKEN", 24),
    hookSecret: required(env, "BRIDGE_HOOK_SECRET", 24),
    dataDir: read(env, "BRIDGE_DATA_DIR", "data"),
    tokenTtlSeconds: integer(env, "BRIDGE_TOKEN_TTL_SECONDS", 900),
    classroomCookieDomain: read(env, "CLASSROOM_COOKIE_DOMAIN"),
    openmaic: {
      baseUrl: url(env, "OPENMAIC_BASE_URL", "http://localhost:3000"),
      token: "",
    },
    lms: {
      baseUrl: url(env, "LMS_BASE_URL"),
      token: read(env, "LMS_API_TOKEN"),
      gradeUsageId,
      accountLookup: read(env, "LMS_ACCOUNT_LOOKUP", "true") !== "false",
    },
    console: {
      baseUrl: url(env, "CONSOLE_BASE_URL"),
      token: read(env, "CONSOLE_SERVICE_TOKEN"),
    },
    omniroute: {
      baseUrl: url(env, "OMNIROUTE_BASE_URL"),
      apiKey: read(env, "OMNIROUTE_API_KEY"),
      model: read(env, "OMNIROUTE_MODEL", "auto"),
    },
    probeTimeoutMs: integer(env, "BRIDGE_PROBE_TIMEOUT_MS", 3000),
    retry: {
      enabled: read(env, "BRIDGE_RETRY_ENABLED", "true") !== "false",
      intervalMs: integer(env, "BRIDGE_RETRY_INTERVAL_MS", 60_000),
      baseMs: integer(env, "BRIDGE_RETRY_BASE_MS", 60_000),
      maxMs: integer(env, "BRIDGE_RETRY_MAX_MS", 3_600_000),
      alertAfterMs: integer(env, "BRIDGE_RETRY_ALERT_AFTER_MS", 1_800_000),
    },
  };
}

/** What is safe to log: never a secret, only whether one is present. */
export function describeConfig(config: Config): Record<string, string | number | boolean> {
  return {
    port: config.port,
    origin: config.origin,
    org: config.org,
    dataDir: config.dataDir,
    tokenTtlSeconds: config.tokenTtlSeconds,
    openmaic: config.openmaic.baseUrl,
    lms: config.lms.baseUrl || "not configured",
    lmsGradeUsageId: config.lms.gradeUsageId || "not configured",
    console: config.console.baseUrl || "not configured",
    omniroute: config.omniroute.baseUrl || "not configured",
    omnirouteModel: config.omniroute.model,
    retryEnabled: config.retry.enabled,
    retryIntervalMs: config.retry.intervalMs,
    retryAlertAfterMs: config.retry.alertAfterMs,
  };
}

/**
 * The bridge's HTTP surface.
 *
 * A deliberately small router over `node:http`: six endpoints, two auth
 * schemes, no framework. The console and OpenMAIC are the only callers, and
 * both are server-side, so there is no CORS surface to get wrong.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  CONTRACT_VERSION,
  HOOK_SIGNATURE_HEADER,
  HOOK_TIMESTAMP_HEADER,
  parseCompletionRequest,
  parseCreateClassroomRequest,
  parseIssueCredentialRequest,
  parseSsoClassroomRequest,
  type HealthResponse,
} from "./contracts.ts";
import { safeEqual, verifyHookSignature } from "./auth.ts";
import type { Config } from "./config.ts";
import type { LedgerStore } from "./ledger.ts";
import {
  FlowError,
  awardCredential,
  completeClassroom,
  createClassroom,
  ssoClassroom,
  transcript,
  type FlowDeps,
} from "./flow.ts";
import { probeLms } from "./clients/lms.ts";
import { probeOpenMaic } from "./clients/openmaic.ts";
import { probeConsole } from "./clients/console.ts";
import { listModels, probeGateway } from "./clients/omniroute.ts";
import type { Fetcher } from "./http.ts";
import { needsRetry, retrySummary } from "./retry.ts";

const MAX_BODY_BYTES = 1024 * 1024;
const SERVICE_NAME = "atheniq-bridge";

export interface HandlerDeps extends FlowDeps {
  config: Config;
  ledger: LedgerStore;
  fetcher?: Fetcher;
  now?: () => Date;
  lmsUserMap?: Record<string, number>;
  lmsUsernameMap?: Record<string, number>;
  startedAt?: Date;
  log?: (line: string) => void;
}

interface Reply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Reply {
  return {
    status,
    body,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  };
}

function failure(status: number, code: string, message: string): Reply {
  return json(status, { ok: false, error: { code, message } });
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) throw new FlowError(413, "BODY_TOO_LARGE", "Request body is too large.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseJson(raw: string): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new FlowError(400, "BAD_JSON", "Request body is not valid JSON.");
  }
}

function bearer(request: IncomingMessage): string {
  const header = request.headers.authorization ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? "";
}

function isService(request: IncomingMessage, config: Config): boolean {
  const token = bearer(request);
  return Boolean(token) && safeEqual(token, config.serviceToken);
}

function serviceRequired(request: IncomingMessage, config: Config): void {
  if (!isService(request, config)) {
    throw new FlowError(401, "UNAUTHORIZED", "A service token is required for this endpoint.");
  }
}

/**
 * A completion arrives either from the console (service token) or from
 * OpenMAIC (a signed body). Both are accepted, and neither can be replayed
 * outside the hook window.
 */
function completionAuthorized(request: IncomingMessage, config: Config, rawBody: string, now: Date): void {
  if (isService(request, config)) return;
  const signature = headerValue(request, HOOK_SIGNATURE_HEADER);
  const timestamp = headerValue(request, HOOK_TIMESTAMP_HEADER);
  const verified = verifyHookSignature(config.hookSecret, { signature, timestamp }, rawBody, now);
  if (!verified.ok) {
    throw new FlowError(401, "UNAUTHORIZED", `Completion is not signed by OpenMAIC (${verified.error}).`);
  }
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

async function health(deps: HandlerDeps): Promise<HealthResponse> {
  const timeout = deps.config.probeTimeoutMs;
  const [lms, openmaic, consoleProbe, gateway] = await Promise.all([
    probeLms({
      baseUrl: deps.config.lms.baseUrl,
      token: deps.config.lms.token,
      gradeUsageId: deps.config.lms.gradeUsageId,
      fetcher: deps.fetcher,
      timeoutMs: timeout,
    }),
    probeOpenMaic({ baseUrl: deps.config.openmaic.baseUrl, fetcher: deps.fetcher, timeoutMs: timeout }),
    probeConsole({
      baseUrl: deps.config.console.baseUrl,
      token: deps.config.console.token,
      fetcher: deps.fetcher,
      timeoutMs: timeout,
    }),
    probeGateway({ ...deps.config.omniroute, fetcher: deps.fetcher, timeoutMs: timeout }),
  ]);

  const retries = retrySummary(deps);
  const checks: HealthResponse["checks"] = [
    { name: "lms", ...lms },
    { name: "openmaic", ...openmaic },
    { name: "console", ...consoleProbe },
    { name: "omniroute", ...gateway },
    {
      name: "completion-retries",
      status: retries.stale > 0 ? "failed" : retries.count > 0 ? "degraded" : "ok",
      detail:
        retries.count === 0
          ? "No completion is waiting for a retry."
          : `${retries.count} completion(s) partial, ${retries.stale} stale; oldest ${retries.oldestAgeSeconds}s.`,
    },
  ];

  // The bridge is up when it can serve; a missing upstream is `degraded`, not
  // `failed`, so a monitor does not page on a deliberately unconfigured dev box.
  // A completion that stayed partial past its alert window is different: it is
  // undelivered work, so it fails the check and pages.
  const failed = checks.some((check) => check.status === "failed");
  const uptimeSeconds = Math.round(
    (Date.now() - (deps.startedAt ?? new Date()).getTime()) / 1000,
  );

  return {
    ok: !failed,
    contract: CONTRACT_VERSION,
    service: SERVICE_NAME,
    uptimeSeconds,
    checks,
    retries,
  };
}

async function route(deps: HandlerDeps, request: IncomingMessage, rawBody: string): Promise<Reply> {
  const url = new URL(request.url ?? "/", deps.config.origin);
  const method = request.method ?? "GET";
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const now = (deps.now ?? (() => new Date()))();

  if (path === "/health" && method === "GET") {
    return json(200, await health(deps));
  }

  if (path === "/v1/gateway/models" && method === "GET") {
    serviceRequired(request, deps.config);
    const models = await listModels({ ...deps.config.omniroute, fetcher: deps.fetcher });
    return json(models.ok ? 200 : 502, models);
  }

  if (path === "/v1/sso/classroom" && method === "POST") {
    serviceRequired(request, deps.config);
    const parsed = parseSsoClassroomRequest(parseJson(rawBody));
    if (!parsed.ok) return failure(400, "INVALID_REQUEST", parsed.error);
    const result = await ssoClassroom(deps, parsed.value);
    return json(200, result);
  }

  if (path === "/v1/classrooms" && method === "POST") {
    serviceRequired(request, deps.config);
    const parsed = parseCreateClassroomRequest(parseJson(rawBody));
    if (!parsed.ok) return failure(400, "INVALID_REQUEST", parsed.error);
    const actor = headerValue(request, "x-atheniq-actor") ?? "console";
    const result = await createClassroom(deps, parsed.value, actor);
    return json(201, result);
  }

  if (path === "/v1/completions" && method === "POST") {
    completionAuthorized(request, deps.config, rawBody, now);
    const parsed = parseCompletionRequest(parseJson(rawBody));
    if (!parsed.ok) return failure(400, "INVALID_REQUEST", parsed.error);
    const retry = url.searchParams.get("retry") === "1";
    const result = await completeClassroom(deps, parsed.value, { retry });
    return json(200, result);
  }

  if (path === "/v1/completions/needs-retry" && method === "GET") {
    serviceRequired(request, deps.config);
    const records = needsRetry(deps, now);
    return json(200, {
      ok: true,
      count: records.length,
      stale: records.filter((record) => record.stale).length,
      records,
    });
  }

  if (path === "/v1/credentials" && method === "POST") {
    serviceRequired(request, deps.config);
    const parsed = parseIssueCredentialRequest(parseJson(rawBody));
    if (!parsed.ok) return failure(400, "INVALID_REQUEST", parsed.error);
    const result = await awardCredential(deps, parsed.value);
    return json(201, result);
  }

  const learnerMatch = /^\/v1\/learners\/([^/]+)\/transcript$/.exec(path);
  if (learnerMatch && method === "GET") {
    serviceRequired(request, deps.config);
    const learnerId = decodeURIComponent(learnerMatch[1] as string);
    return json(200, { learnerId, entries: transcript(deps, learnerId) });
  }

  const classroomMatch = /^\/v1\/classrooms\/([^/]+)$/.exec(path);
  if (classroomMatch && method === "GET") {
    serviceRequired(request, deps.config);
    const id = decodeURIComponent(classroomMatch[1] as string);
    const record = deps.ledger.snapshot().classrooms.find((item) => item.id === id);
    if (!record) return failure(404, "NOT_FOUND", "No such classroom.");
    return json(200, record);
  }

  if (
    [
      "/v1/sso/classroom",
      "/v1/classrooms",
      "/v1/completions",
      "/v1/completions/needs-retry",
      "/v1/credentials",
    ].includes(path)
  ) {
    return failure(405, "METHOD_NOT_ALLOWED", `${method} is not allowed on ${path}.`);
  }
  return failure(404, "NOT_FOUND", `No route for ${method} ${path}.`);
}

export function createHandler(deps: HandlerDeps) {
  const log = deps.log ?? (() => undefined);

  return async function handler(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const started = Date.now();
    const requestId = (headerValue(request, "x-request-id") ?? "").slice(0, 64) || cryptoRandom();
    response.setHeader("x-request-id", requestId);

    try {
      const rawBody = request.method === "GET" || request.method === "HEAD" ? "" : await readBody(request);
      const reply = await route(deps, request, rawBody);
      for (const [name, value] of Object.entries(reply.headers ?? {})) response.setHeader(name, value);
      response.statusCode = reply.status;
      response.end(JSON.stringify(reply.body));
      log(`${reply.status} ${request.method} ${request.url} ${Date.now() - started}ms ${requestId}`);
    } catch (error) {
      const flow = error instanceof FlowError ? error : null;
      const status = flow?.status ?? 500;
      const code = flow?.code ?? "INTERNAL_ERROR";
      const message = flow?.message ?? "The bridge could not complete that request.";
      if (!flow) log(`ERROR ${request.method} ${request.url} ${String(error)} ${requestId}`);
      else log(`${status} ${request.method} ${request.url} ${code} ${requestId}`);
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.setHeader("cache-control", "no-store");
      response.statusCode = status;
      response.end(JSON.stringify({ ok: false, error: { code, message } }));
    }
  };
}

function cryptoRandom(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function createBridgeServer(deps: HandlerDeps): Server {
  return createServer(createHandler(deps));
}

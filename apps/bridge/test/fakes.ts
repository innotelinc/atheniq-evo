/**
 * Fake upstreams.
 *
 * The four systems this bridge talks to are external services with their own
 * databases and boot times. Tests exercise the bridge's real HTTP surface and
 * its real signing against these stand-ins, which record every call so a test
 * can assert on *what the bridge sent*, not only on what it returned.
 */

import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { LedgerStore } from "../src/ledger.ts";
import { createBridgeServer } from "../src/app.ts";
import { loadConfig, type Config } from "../src/config.ts";

export interface Recorded {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: unknown;
}

export interface Fake {
  url: string;
  calls: Recorded[];
  close: () => Promise<void>;
}

type Responder = (call: Recorded) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>;

export async function fakeServer(responder: Responder): Promise<Fake> {
  const calls: Recorded[] = [];
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
    const raw = Buffer.concat(chunks).toString("utf8");
    let body: unknown = null;
    if (raw) {
      try {
        body = JSON.parse(raw) as unknown;
      } catch {
        body = raw;
      }
    }
    const call: Recorded = {
      method: request.method ?? "GET",
      path: request.url ?? "/",
      headers: request.headers,
      body,
    };
    calls.push(call);
    const reply = await responder(call);
    response.statusCode = reply.status;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(reply.body));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

export interface Stack {
  bridge: { url: string; close: () => Promise<void> };
  openmaic: Fake;
  lms: Fake;
  console: Fake;
  omniroute: Fake;
  ledger: LedgerStore;
  config: Config;
  secret: string;
  serviceToken: string;
  hookSecret: string;
  cleanup: () => Promise<void>;
}

export interface StackOptions {
  /** Let a test make the console fail its first call. */
  consoleFailsOnce?: boolean;
  /** Make the console fail this many calls; `Infinity` for a sustained outage. */
  consoleFailures?: number;
  /** Extra environment for `loadConfig`, e.g. retry timing. */
  env?: Record<string, string>;
  /** Configure the LMS grade write by giving a numeric user id for this learner. */
  lmsUserMap?: Record<string, number>;
  withLmsCredentials?: boolean;
}

export async function startStack(options: StackOptions = {}): Promise<Stack> {
  let consoleFailuresLeft = options.consoleFailures ?? (options.consoleFailsOnce ? 1 : 0);

  const openmaic = await fakeServer((call) => {
    if (call.path === "/api/health") return { status: 200, body: { ok: true } };
    if (call.path === "/api/generate-classroom") {
      return { status: 202, body: { success: true, data: { id: "job_abc", stageId: "stage_xyz" } } };
    }
    return { status: 404, body: {} };
  });

  const lms = await fakeServer((call) => {
    if (call.path.startsWith("/api/completion/v1/completion-batch")) {
      return { status: 200, body: { detail: "ok" } };
    }
    if (call.path.includes("/api/grades/v1/gradebook/")) {
      return { status: 202, body: [{ user_id: 7, usage_id: "block", success: true, reason: null }] };
    }
    return { status: 200, body: { results: [], pagination: {} } };
  });

  const consoleFake = await fakeServer((call) => {
    if (consoleFailuresLeft > 0) {
      consoleFailuresLeft -= 1;
      return { status: 503, body: { ok: false, error: "console restarting" } };
    }
    const body = (call.body ?? {}) as Record<string, unknown>;
    if (body.action === "complete-enrollment") {
      return {
        status: 200,
        body: { ok: true, data: { eligible: [String(body.courseKey)], credits: 3 } },
      };
    }
    if (body.action === "issue-credential") {
      return {
        status: 201,
        body: {
          ok: true,
          data: {
            credentialId: "crd_test",
            verifyId: "ATH-2026-TEST01",
            status: "issued",
          },
        },
      };
    }
    return { status: 400, body: { ok: false, error: "unknown action" } };
  });

  const omniroute = await fakeServer(() => ({
    status: 200,
    body: { data: [{ id: "auto/best-chat" }, { id: "gpt-5.5" }] },
  }));

  const secret = "test-jwt-secret-that-is-long-enough-32";
  const serviceToken = "test-service-token-long-enough";
  const hookSecret = "test-hook-secret-long-enough-24";

  const config = loadConfig({
    PORT: "0",
    BRIDGE_ORIGIN: "http://127.0.0.1:8787",
    ATHENIQ_ORG: "AthenIQ Institute",
    BRIDGE_JWT_SECRET: secret,
    BRIDGE_SERVICE_TOKEN: serviceToken,
    BRIDGE_HOOK_SECRET: hookSecret,
    BRIDGE_DATA_DIR: "data/test",
    BRIDGE_TOKEN_TTL_SECONDS: "900",
    OPENMAIC_BASE_URL: openmaic.url,
    LMS_BASE_URL: lms.url,
    ...(options.withLmsCredentials === false ? {} : { LMS_API_TOKEN: "lms-staff-token" }),
    LMS_GRADE_USAGE_ID:
      "block-v1:InnotelLabs+CS101+2026F+type@sequential+block@ai_classroom",
    CONSOLE_BASE_URL: consoleFake.url,
    CONSOLE_SERVICE_TOKEN: "console-service-token",
    OMNIROUTE_BASE_URL: omniroute.url,
    OMNIROUTE_API_KEY: "omniroute-key",
    OMNIROUTE_MODEL: "auto/best-chat",
    BRIDGE_PROBE_TIMEOUT_MS: "2000",
    ...options.env,
  } as NodeJS.ProcessEnv);

  const ledger = new LedgerStore(`${process.cwd()}/data/test/ledger-${Date.now()}-${Math.random()}.json`);
  await ledger.load();

  const server = createBridgeServer({
    config,
    ledger,
    lmsUserMap: options.lmsUserMap ?? {},
    startedAt: new Date(),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    bridge: {
      url: `http://127.0.0.1:${port}`,
      close: () =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    },
    openmaic,
    lms,
    console: consoleFake,
    omniroute,
    ledger,
    config,
    secret,
    serviceToken,
    hookSecret,
    cleanup: async () => {
      await Promise.all([openmaic.close(), lms.close(), consoleFake.close(), omniroute.close()]);
    },
  };
}

export const COURSE_KEY = "course-v1:InnotelLabs+CS101+2026F";
export const LEARNER_ID = "lrn_000000000000000000000001";

export async function post(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

export async function get(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, { headers });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

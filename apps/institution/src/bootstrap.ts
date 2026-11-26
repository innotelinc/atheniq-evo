/**
 * The one-shot bootstrap behind /setup.
 *
 * A fresh install has no registrar credential and no session secret, so the
 * service cannot start its normal router. It starts this small server instead:
 * /health, and /setup guarded by a one-time token printed to the log. A
 * successful post hashes the registrar password, generates the session secret,
 * tests the mail provider when one is configured, and writes `setup.json` with
 * mode 0600 through a temporary file and a rename. From then on the file is the
 * configuration: /setup answers 404, and the normal service boots with it.
 *
 * A non-empty environment variable still wins over the file, so an operator can
 * rotate a value without editing the file. Compose passes the bootstrap-owned
 * variables empty for that reason.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { hashPassword, safeEqual } from "./auth.ts";
import { ConfigError, institutionDataDir, loadConfig, type InstitutionConfig } from "./config.ts";
import { createMailer, type MailSettings } from "./mail.ts";
import { setupCompletePage, setupForm, setupLockedPage } from "./views/setup.ts";

export const SETUP_FILE = "setup.json";
const SETUP_VERSION = 1;
const MAX_BODY_BYTES = 16 * 1024;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const DOMAIN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;

export class SetupError extends Error {}

export interface SetupRecord {
  version: number;
  completedAt: string;
  env: Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function setupPath(dataDir: string): string {
  return join(resolve(dataDir), SETUP_FILE);
}

/** True when a setup file exists, whether or not its contents parse. */
export function setupComplete(dataDir: string): boolean {
  return existsSync(setupPath(dataDir));
}

/**
 * Read and validate the setup file. A corrupt file is a hard error rather than
 * a reason to reopen the wizard: setup already ran, and silently accepting a
 * new registrar because the file was damaged would be a takeover path.
 */
export function readSetupRecord(dataDir: string): SetupRecord | null {
  const file = setupPath(dataDir);
  if (!existsSync(file)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch (error) {
    throw new SetupError(
      `${file} is not valid JSON (${error instanceof Error ? error.message : String(error)}); fix or remove it before starting.`,
    );
  }
  if (!isRecord(parsed) || parsed.version !== SETUP_VERSION || !isRecord(parsed.env)) {
    throw new SetupError(`${file} is not a version ${SETUP_VERSION} setup file; fix or remove it before starting.`);
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed.env)) {
    if (typeof value !== "string") throw new SetupError(`${file} has a non-string value for ${key}.`);
    env[key] = value;
  }
  return { version: SETUP_VERSION, completedAt: String(parsed.completedAt ?? ""), env };
}

/** Environment values win when they are not blank; blank means "use the file". */
export function mergeSetupEnv(env: NodeJS.ProcessEnv, setupEnv: Record<string, string>): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...setupEnv };
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string" && value.trim() !== "") merged[key] = value;
  }
  return merged;
}

/** Load configuration with the setup file as a fallback under the environment. */
export function loadConfigWithSetup(env: NodeJS.ProcessEnv = process.env): InstitutionConfig {
  const record = readSetupRecord(institutionDataDir(env));
  if (!record) return loadConfig(env);
  const config = loadConfig(mergeSetupEnv(env, record.env));
  for (const [key, value] of Object.entries(record.env)) {
    const override = (env[key] ?? "").trim();
    if (override && override !== value) {
      config.warnings.push(`${key} is set in the environment and overrides ${SETUP_FILE}.`);
    }
  }
  return config;
}

/**
 * True only when nothing has configured the bootstrap-owned values. A partial
 * environment is not a fresh install: it is a mistake, and the normal config
 * validator should say so instead of opening the wizard.
 */
export function missingBootstrapValues(env: NodeJS.ProcessEnv = process.env): boolean {
  const has = (name: string): boolean => (env[name] ?? "").trim().length > 0;
  return (
    !has("SESSION_SECRET") &&
    !has("REGISTRAR_EMAIL") &&
    !has("REGISTRAR_PASSWORD") &&
    !has("REGISTRAR_PASSWORD_HASH")
  );
}

export function createSetupToken(): string {
  return randomBytes(24).toString("base64url");
}

/**
 * Write the setup file atomically and privately. A partial write must never be
 * readable as configuration, so the bytes go to a temporary file in the same
 * directory, are chmodded, and are then renamed over the final name.
 */
export function writeSetupConfig(dataDir: string, values: Record<string, string>, now: Date = new Date()): string {
  const directory = resolve(dataDir);
  mkdirSync(directory, { recursive: true });
  const file = setupPath(directory);
  if (existsSync(file)) throw new SetupError(`${file} already exists; setup is complete.`);

  const record: SetupRecord = { version: SETUP_VERSION, completedAt: now.toISOString(), env: values };
  const temporary = join(directory, `.${SETUP_FILE}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
  try {
    writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    try {
      chmodSync(temporary, 0o600);
    } catch {
      // Windows does not implement POSIX modes; the file is still user-scoped.
    }
    renameSync(temporary, file);
    try {
      chmodSync(file, 0o600);
    } catch {
      // As above.
    }
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary file may never have been created.
    }
    throw new SetupError(
      `could not write ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return file;
}

/* ------------------------------------------------------------- setup server */

export interface SetupServerOptions {
  dataDir: string;
  publicOrigin?: string;
  /** Supplied by tests; production prints a fresh token at startup. */
  token?: string;
  /** Override for tests; defaults to the real provider preflight. */
  testMail?: (settings: MailSettings) => Promise<void>;
  /** The environment to validate against. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}

export interface SetupServer {
  server: Server;
  token: string;
}

interface SetupValues {
  registrarEmail: string;
  registrarPassword: string;
  mailProvider: "local" | "stalwart";
  mailDomain: string;
  stalwartUrl: string;
  stalwartToken: string;
  seedDemo: boolean;
}

type Parsed =
  | { ok: true; values: SetupValues }
  | { ok: false; fields: Record<string, string>; error: string };

function parseValues(form: URLSearchParams): Parsed {
  const fields: Record<string, string> = {};
  const email = (form.get("registrarEmail") ?? "").trim().toLowerCase();
  const password = form.get("registrarPassword") ?? "";
  const confirm = form.get("confirmPassword") ?? "";
  const provider = (form.get("mailProvider") ?? "local").trim().toLowerCase();
  const domain = (form.get("mailDomain") ?? "").trim().toLowerCase();
  const stalwartUrl = (form.get("stalwartUrl") ?? "").trim();
  const stalwartToken = (form.get("stalwartToken") ?? "").trim();
  const seedDemo = form.get("seedDemo") === "true";

  if (!EMAIL.test(email) || email.length > 200) fields.registrarEmail = "Enter a valid email address.";
  if (password.length < 12) fields.registrarPassword = "Use at least 12 characters.";
  if (password.length > 1_024) fields.registrarPassword = "Keep the password under 1,024 characters.";
  if (confirm !== password) fields.confirmPassword = "The two passwords do not match.";
  if (provider !== "local" && provider !== "stalwart") fields.mailProvider = "Choose a mail provider.";
  if (!DOMAIN.test(domain) || domain.length > 253) fields.mailDomain = "Enter a valid mail domain.";

  if (provider === "stalwart") {
    let parsed: URL | null = null;
    try {
      parsed = new URL(stalwartUrl);
    } catch {
      parsed = null;
    }
    if (!parsed || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
      fields.stalwartUrl = "Enter an absolute http(s) URL.";
    }
    if (stalwartToken.length < 16) fields.stalwartToken = "Enter the Stalwart API key (16+ characters).";
  }

  if (Object.keys(fields).length > 0) {
    return { ok: false, fields, error: "Please correct the highlighted fields." };
  }
  return {
    ok: true,
    values: {
      registrarEmail: email,
      registrarPassword: password,
      mailProvider: provider as "local" | "stalwart",
      mailDomain: domain,
      stalwartUrl,
      stalwartToken,
      seedDemo,
    },
  };
}

function mailSettings(values: SetupValues, env: NodeJS.ProcessEnv): MailSettings {
  const quota = Number.parseInt((env.STALWART_QUOTA_BYTES ?? "").trim(), 10);
  return {
    mailProvider: values.mailProvider,
    mailDomain: values.mailDomain,
    stalwartUrl: values.stalwartUrl,
    stalwartToken: values.stalwartToken,
    stalwartQuotaBytes: Number.isFinite(quota) && quota > 0 ? quota : 0,
  };
}

function setupEnv(values: SetupValues): Record<string, string> {
  const env: Record<string, string> = {
    SESSION_SECRET: randomBytes(32).toString("hex"),
    REGISTRAR_EMAIL: values.registrarEmail,
    REGISTRAR_PASSWORD_HASH: hashPassword(values.registrarPassword),
    MAIL_PROVIDER: values.mailProvider,
    MAIL_DOMAIN: values.mailDomain,
    INSTITUTION_SEED_DEMO: values.seedDemo ? "true" : "false",
  };
  if (values.mailProvider === "stalwart") {
    env.STALWART_URL = values.stalwartUrl;
    env.STALWART_TOKEN = values.stalwartToken;
  }
  return env;
}

function safeValues(values: SetupValues): Record<string, string> {
  return {
    registrarEmail: values.registrarEmail,
    mailProvider: values.mailProvider,
    mailDomain: values.mailDomain,
    stalwartUrl: values.stalwartUrl,
    seedDemo: values.seedDemo ? "true" : "false",
  };
}

async function defaultTestMail(settings: MailSettings): Promise<void> {
  const mailer = createMailer(settings);
  if (mailer) await mailer.preflight();
}

export function startSetupServer(options: SetupServerOptions): SetupServer {
  const env = options.env ?? process.env;
  const publicOrigin = (options.publicOrigin ?? "http://localhost:8080").replace(/\/+$/, "");
  const token = options.token ?? createSetupToken();
  const testMail = options.testMail ?? defaultTestMail;
  const log = options.log ?? ((line: string) => {
    if (process.env.NODE_ENV !== "test") console.log(line);
  });
  let completed = setupComplete(options.dataDir);
  let writing = false;

  function send(response: ServerResponse, status: number, body: string, type = "text/html; charset=utf-8"): void {
    response.statusCode = status;
    response.setHeader("content-type", type);
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("x-frame-options", "DENY");
    // The setup page carries its own small stylesheet and has no scripts.
    response.setHeader(
      "content-security-policy",
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
    response.end(body);
  }

  function notFound(response: ServerResponse): void {
    send(response, 404, "<!doctype html><meta charset=utf-8><title>Not found</title><p>Not found.</p>");
  }

  async function readForm(request: IncomingMessage): Promise<URLSearchParams> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      size += buffer.byteLength;
      if (size > MAX_BODY_BYTES) throw new SetupError("The setup form was too large.");
      chunks.push(buffer);
    }
    return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  }

  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      console.error(`[institution] setup failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      if (!response.headersSent) send(response, 500, "<!doctype html><meta charset=utf-8><title>Error</title><p>Setup could not complete.</p>");
      else response.end();
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method === "HEAD" ? "HEAD" : request.method === "POST" ? "POST" : "GET";
    const url = new URL(request.url ?? "/", publicOrigin);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/health") {
      send(response, 200, JSON.stringify({ ok: true, service: "atheniq-institution", setup: completed ? "complete" : "required" }), "application/json; charset=utf-8");
      return;
    }
    if (path !== "/setup") {
      notFound(response);
      return;
    }
    if (completed) {
      notFound(response);
      return;
    }
    if (method !== "GET" && method !== "HEAD" && method !== "POST") {
      response.setHeader("allow", "GET, HEAD, POST");
      send(response, 405, "<!doctype html><meta charset=utf-8><title>Method not allowed</title><p>Method not allowed.</p>");
      return;
    }

    if (method === "GET" || method === "HEAD") {
      if (!safeEqual(url.searchParams.get("token") ?? "", token)) {
        send(response, 403, setupLockedPage("Open the link printed in the service log. The token is required and changes when the service restarts."));
        return;
      }
      const body = setupForm({ token });
      send(response, 200, method === "HEAD" ? "" : body);
      return;
    }

    let form: URLSearchParams;
    try {
      form = await readForm(request);
    } catch (error) {
      send(response, 413, setupLockedPage(error instanceof SetupError ? error.message : "The request could not be read."));
      return;
    }
    if (!safeEqual(form.get("token") ?? "", token)) {
      send(response, 403, setupLockedPage("The setup token is missing or wrong. Use the link printed in the service log."));
      return;
    }

    const parsed = parseValues(form);
    if (!parsed.ok) {
      send(response, 422, setupForm({ token, values: safeValuesFrom(form), fields: parsed.fields, error: parsed.error }));
      return;
    }

    const values = parsed.values;
    const nextEnv = setupEnv(values);

    // Validate the complete configuration before writing it: a file that cannot
    // boot is worse than a refused form.
    try {
      loadConfig(mergeSetupEnv(env, nextEnv));
    } catch (error) {
      send(
        response,
        422,
        setupForm({
          token,
          values: safeValues(values),
          error: error instanceof ConfigError ? error.message : String(error),
        }),
      );
      return;
    }

    try {
      await testMail(mailSettings(values, env));
    } catch (error) {
      send(
        response,
        422,
        setupForm({
          token,
          values: safeValues(values),
          error: `The mail test failed: ${error instanceof Error ? error.message : String(error)}`,
        }),
      );
      return;
    }

    if (writing || setupComplete(options.dataDir)) {
      completed = true;
      notFound(response);
      return;
    }
    writing = true;
    let file: string;
    try {
      file = writeSetupConfig(options.dataDir, nextEnv);
      completed = true;
    } catch (error) {
      send(response, 500, setupLockedPage(error instanceof SetupError ? error.message : "The configuration could not be written."));
      return;
    } finally {
      writing = false;
    }
    log(`atheniq-institution: setup complete; configuration written to ${file}. Restart the service.`);
    send(response, 200, setupCompletePage({ file }));
  }

  return { server, token };
}

/** Re-render a failed form without ever putting secrets back into the HTML. */
function safeValuesFrom(form: URLSearchParams): Record<string, string> {
  return {
    registrarEmail: (form.get("registrarEmail") ?? "").trim(),
    mailProvider: (form.get("mailProvider") ?? "local").trim(),
    mailDomain: (form.get("mailDomain") ?? "").trim(),
    stalwartUrl: (form.get("stalwartUrl") ?? "").trim(),
    seedDemo: form.get("seedDemo") === "true" ? "true" : "false",
  };
}

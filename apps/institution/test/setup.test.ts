/**
 * First-run setup: the token gate, the atomic 0600 write, password hashing, the
 * mail test, environment precedence, and the 404 once setup is complete.
 */

import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hashPassword, verifyPassword } from "../src/auth.ts";
import {
  loadConfigWithSetup,
  missingBootstrapValues,
  readSetupRecord,
  SETUP_FILE,
  setupComplete,
  setupPath,
  startSetupServer,
  writeSetupConfig,
} from "../src/bootstrap.ts";

const PASSWORD = "registrar-password-1234";

function temporaryDir(): string {
  return mkdtempSync(join(tmpdir(), "atheniq-setup-"));
}

function form(overrides: Record<string, string> = {}): URLSearchParams {
  return new URLSearchParams({
    token: "test-token",
    registrarEmail: "registrar@atheniq.institute",
    registrarPassword: PASSWORD,
    confirmPassword: PASSWORD,
    mailProvider: "local",
    mailDomain: "atheniq.institute",
    seedDemo: "false",
    ...overrides,
  });
}

async function boot(
  dir: string,
  options: { testMail?: () => Promise<void>; token?: string } = {},
): Promise<{ base: string; close: () => Promise<void> }> {
  const setup = startSetupServer({
    dataDir: dir,
    publicOrigin: "http://127.0.0.1",
    token: options.token ?? "test-token",
    env: { NODE_ENV: "test" },
    log: () => {},
    ...(options.testMail ? { testMail: options.testMail } : {}),
  });
  setup.server.listen(0, "127.0.0.1");
  await once(setup.server, "listening");
  const port = (setup.server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    close: async () => {
      setup.server.close();
      await once(setup.server, "close");
    },
  };
}

function post(base: string, body: URLSearchParams): Promise<Response> {
  return fetch(`${base}/setup`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
}

test("the setup server refuses requests without the one-time token", async (t) => {
  const dir = temporaryDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const app = await boot(dir);
  t.after(app.close);

  assert.equal((await fetch(`${app.base}/setup`)).status, 403);
  assert.equal((await fetch(`${app.base}/setup?token=wrong`)).status, 403);

  const ok = await fetch(`${app.base}/setup?token=test-token`);
  assert.equal(ok.status, 200);
  const html = await ok.text();
  assert.match(html, /name="registrarEmail"/);
  assert.match(html, /name="token" value="test-token"/);
  assert.equal(setupComplete(dir), false, "viewing the form writes nothing");
});

test("a post without the token is refused and writes nothing", async (t) => {
  const dir = temporaryDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const app = await boot(dir);
  t.after(app.close);

  const response = await post(app.base, form({ token: "wrong" }));
  assert.equal(response.status, 403);
  assert.equal(setupComplete(dir), false);
});

test("a successful post writes a hashed, 0600 configuration and closes setup", async (t) => {
  const dir = temporaryDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const app = await boot(dir);
  t.after(app.close);

  const response = await post(app.base, form());
  assert.equal(response.status, 200);
  const page = await response.text();

  assert.equal(setupComplete(dir), true);
  const record = readSetupRecord(dir);
  assert.ok(record);
  if (!record) return;

  assert.match(record.env.SESSION_SECRET ?? "", /^[0-9a-f]{64}$/);
  assert.equal(record.env.REGISTRAR_EMAIL, "registrar@atheniq.institute");
  assert.ok((record.env.REGISTRAR_PASSWORD_HASH ?? "").startsWith("scrypt$"));
  assert.equal(verifyPassword(PASSWORD, record.env.REGISTRAR_PASSWORD_HASH ?? ""), true);
  assert.equal(record.env.REGISTRAR_PASSWORD, undefined, "plaintext is never stored");
  assert.equal(record.env.MAIL_PROVIDER, "local");
  assert.equal(record.env.INSTITUTION_SEED_DEMO, "false");

  assert.ok(!page.includes(PASSWORD), "the response must not echo the password");
  assert.ok(!page.includes(record.env.SESSION_SECRET ?? ""), "the response must not echo the session secret");

  assert.equal((await fetch(`${app.base}/setup?token=test-token`)).status, 404);
  assert.equal((await post(app.base, form())).status, 404);
});

test("a failed mail test leaves no configuration behind", async (t) => {
  const dir = temporaryDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const app = await boot(dir, {
    testMail: async () => {
      throw new Error("Stalwart has no domain atheniq.institute");
    },
  });
  t.after(app.close);

  const response = await post(
    app.base,
    form({
      mailProvider: "stalwart",
      stalwartUrl: "https://mail.atheniq.institute",
      stalwartToken: "a-long-enough-stalwart-token",
    }),
  );
  assert.equal(response.status, 422);
  const page = await response.text();
  assert.match(page, /mail test failed/i);
  assert.match(page, /no domain/i);
  assert.equal(setupComplete(dir), false);
});

test("the setup form is 404 once the file exists", async (t) => {
  const dir = temporaryDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeSetupConfig(dir, {
    SESSION_SECRET: "a".repeat(64),
    REGISTRAR_EMAIL: "registrar@atheniq.institute",
    REGISTRAR_PASSWORD_HASH: hashPassword(PASSWORD),
  });

  const app = await boot(dir);
  t.after(app.close);

  assert.equal((await fetch(`${app.base}/setup?token=test-token`)).status, 404);
  const health = await fetch(`${app.base}/health`);
  assert.equal(health.status, 200);
  const status = (await health.json()) as { setup?: string };
  assert.equal(status.setup, "complete");
});

test("the configuration file is private, atomic, and immutable once written", (t) => {
  const dir = temporaryDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const file = writeSetupConfig(dir, { SESSION_SECRET: "secret-value" });
  assert.equal(file, setupPath(dir));

  if (process.platform !== "win32") {
    assert.equal(statSync(file).mode & 0o777, 0o600);
  }
  assert.deepEqual(readdirSync(dir), [SETUP_FILE], "no temporary file is left behind");

  const parsed = JSON.parse(readFileSync(file, "utf8")) as { version: number; env: Record<string, string> };
  assert.equal(parsed.version, 1);
  assert.equal(parsed.env.SESSION_SECRET, "secret-value");

  assert.throws(() => writeSetupConfig(dir, { SESSION_SECRET: "replacement" }), /already exists/);
});

test("the setup file boots a complete configuration, and a non-empty env wins", (t) => {
  const dir = temporaryDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const hash = hashPassword(PASSWORD);
  writeSetupConfig(dir, {
    SESSION_SECRET: "a".repeat(64),
    REGISTRAR_EMAIL: "registrar@atheniq.institute",
    REGISTRAR_PASSWORD_HASH: hash,
    MAIL_DOMAIN: "atheniq.institute",
    MAIL_PROVIDER: "local",
  });

  const config = loadConfigWithSetup({ INSTITUTION_DATA_DIR: dir, NODE_ENV: "test" });
  assert.equal(config.registrarEmail, "registrar@atheniq.institute");
  assert.equal(config.sessionSecret, "a".repeat(64));
  assert.equal(verifyPassword(PASSWORD, config.registrarPassword), true);

  const overridden = loadConfigWithSetup({
    INSTITUTION_DATA_DIR: dir,
    NODE_ENV: "test",
    SESSION_SECRET: "b".repeat(64),
  });
  assert.equal(overridden.sessionSecret, "b".repeat(64));
  assert.ok(overridden.warnings.some((warning) => /overrides setup\.json/.test(warning)));
});

test("a fresh install is recognised only when nothing is configured", () => {
  assert.equal(missingBootstrapValues({}), true);
  assert.equal(missingBootstrapValues({ SESSION_SECRET: "" }), true);
  assert.equal(missingBootstrapValues({ SESSION_SECRET: "x" }), false);
  assert.equal(missingBootstrapValues({ REGISTRAR_EMAIL: "registrar@atheniq.institute" }), false);
});

/**
 * The mailbox retry route, end to end through the real server: a reserved
 * address either has no provider to reach, or becomes a working mailbox and
 * hands back the temporary password it issued. The registrar surface is chosen
 * by `Host`, sign-in supplies the staff cookie, and the reply is the student
 * record the registrar sees.
 */

import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { loadConfig } from "../src/config.ts";
import type { Mailer } from "../src/mail.ts";
import { Registry } from "../src/registry.ts";
import { createInstitutionServer } from "../src/server.ts";
import { Store, type Student } from "../src/store.ts";

const REGISTRAR_EMAIL = "registrar@atheniq.institute";
const REGISTRAR_PASSWORD = "atheniq-registrar";

function config() {
  return loadConfig({
    NODE_ENV: "test",
    SESSION_SECRET: "s".repeat(48),
    REGISTRAR_EMAIL,
    REGISTRAR_PASSWORD,
    INSTITUTION_SEED_DEMO: "false",
    INSTITUTION_ORIGIN: "http://localhost:8080",
    REGISTRAR_ORIGIN: "http://registrar.localhost:8080",
    MAIL_PROVIDER: "local",
  });
}

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** A request on the registrar surface: `Host` is what the dispatch reads. */
function call(
  port: number,
  method: "GET" | "POST",
  path: string,
  options: { cookie?: string; body?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = options.body ?? "";
    const headers: Record<string, string> = { host: "registrar.localhost" };
    if (options.cookie) headers.cookie = options.cookie;
    if (method === "POST") {
      headers["content-type"] = "application/x-www-form-urlencoded";
      headers["content-length"] = String(Buffer.byteLength(payload));
    }
    const request = httpRequest({ hostname: "127.0.0.1", port, method, path, headers }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }));
    });
    request.on("error", reject);
    request.end(payload);
  });
}

interface Instance {
  port: number;
  registry: Registry;
  student: Student;
  close: () => Promise<void>;
}

/** Admit one student, leaving the mailbox reserved, and serve the registrar. */
async function open(mailer: Mailer | null): Promise<Instance> {
  const settings = config();
  const registry = new Registry(Store.inMemory(), settings);
  const created = registry.createApplication({
    firstName: "Ada",
    lastName: "Lovelace",
    email: "ada@example.com",
    country: "United Kingdom",
    programSlug: "bsc-applied-ai",
    termId: "2027A",
    statement:
      "I have spent four years building scheduling software for a regional health service and want the mathematics to reason about it properly.",
    consent: "on",
  });
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error("the test application was refused");

  const admitted = registry.decide(created.value.id, "admit", "");
  assert.equal(admitted.ok, true);
  const student = admitted.ok ? admitted.value.student : undefined;
  assert.ok(student, "admission must create the student");
  assert.equal(student.mailbox.status, "reserved", "a local mail provider leaves the address reserved");
  if (!student) throw new Error("admission created no student");

  const server = createInstitutionServer({ config: settings, registry, mailer });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    port,
    registry,
    student,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function staffCookie(port: number): Promise<string> {
  const reply = await call(port, "POST", "/signin", {
    body: new URLSearchParams({ email: REGISTRAR_EMAIL, password: REGISTRAR_PASSWORD }).toString(),
  });
  assert.equal(reply.status, 303);
  const setCookie = reply.headers["set-cookie"];
  const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  assert.ok(first, "sign-in must set the staff cookie");
  return String(first).split(";")[0] ?? "";
}

function stubMailer(): Mailer & { calls: { address: string; password: string }[] } {
  const calls: { address: string; password: string }[] = [];
  return {
    provider: "stub",
    passwordManaged: true,
    calls,
    preflight: async () => {},
    ensureAccount: async (address, password) => {
      calls.push({ address, password });
    },
  };
}

test("a retry without a provider explains why and leaves the address reserved", async () => {
  const instance = await open(null);
  try {
    const cookie = await staffCookie(instance.port);
    const reply = await call(instance.port, "POST", `/students/${instance.student.id}/mailbox`, { cookie });

    assert.equal(reply.status, 200);
    assert.match(reply.body, /still reserved/);
    assert.match(reply.body, /MAIL_PROVIDER is local/);
    assert.match(reply.body, /Retry mailbox<\/button>/, "the address stays actionable");
    assert.match(reply.body, /disabled/, "but the button is not offered while no provider exists");
    assert.equal(instance.registry.student(instance.student.id)?.mailbox.status, "reserved");
  } finally {
    await instance.close();
  }
});

test("a retry with a provider activates the mailbox and shows the password once", async () => {
  const mailer = stubMailer();
  const instance = await open(mailer);
  try {
    const cookie = await staffCookie(instance.port);
    const reply = await call(instance.port, "POST", `/students/${instance.student.id}/mailbox`, { cookie });

    assert.equal(reply.status, 200);
    assert.match(reply.body, /Mailbox activated at stub/);
    assert.equal(mailer.calls.length, 1, "the provider is asked exactly once");
    assert.equal(mailer.calls[0]?.address, instance.student.schoolEmail);
    assert.match(mailer.calls[0]?.password ?? "", /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
    assert.ok(
      reply.body.includes(mailer.calls[0]?.password ?? ""),
      "the issued temporary password must be handed over on the record",
    );

    assert.equal(instance.registry.student(instance.student.id)?.mailbox.status, "active");
    assert.ok(
      !reply.body.includes(`/students/${instance.student.id}/mailbox`),
      "an active mailbox offers no retry",
    );
  } finally {
    await instance.close();
  }
});

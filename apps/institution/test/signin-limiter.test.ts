/**
 * The sign-in limiter's client address, through the real server.
 *
 * Behind an edge that does not pass `X-Forwarded-For` through trust, every
 * request looks like the edge. These tests pin both modes: direct ignores the
 * header, and proxied uses the address the trusted proxy appended (the last
 * valid entry), not one the client wrote earlier in the list.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { loadConfig } from "../src/config.ts";
import { Registry } from "../src/registry.ts";
import { createInstitutionServer } from "../src/server.ts";
import { Store } from "../src/store.ts";

interface Instance {
  port: number;
  close: () => Promise<void>;
}

async function serve(trustProxy: boolean): Promise<Instance> {
  const config = loadConfig({
    NODE_ENV: "test",
    SESSION_SECRET: "s".repeat(48),
    REGISTRAR_EMAIL: "registrar@atheniq.institute",
    REGISTRAR_PASSWORD: "atheniq-registrar",
    INSTITUTION_SEED_DEMO: "false",
    INSTITUTION_ORIGIN: "http://localhost:8080",
    REGISTRAR_ORIGIN: "http://registrar.localhost:8080",
    MAIL_PROVIDER: "local",
    TRUST_PROXY: trustProxy ? "true" : "false",
  });
  const registry = new Registry(Store.inMemory(), config);
  const server = createInstitutionServer({ config, registry, mailer: null });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

/** One failed student sign-in; the status is what the limiter decides. */
function signIn(port: number, email: string, forwarded?: string): Promise<number> {
  const body = new URLSearchParams({ email, password: "definitely-not-the-password" }).toString();
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      host: "localhost:8080",
      "content-type": "application/x-www-form-urlencoded",
      "content-length": String(Buffer.byteLength(body)),
    };
    if (forwarded) headers["x-forwarded-for"] = forwarded;
    const request = httpRequest(
      { hostname: "127.0.0.1", port, method: "POST", path: "/portal/signin", headers },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode ?? 0));
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

test("direct mode ignores X-Forwarded-For and buckets by the socket peer", async () => {
  const site = await serve(false);
  try {
    const email = `direct-${randomUUID()}@example.org`;
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      assert.equal(await signIn(site.port, email, `203.0.113.${attempt}`), 401, `attempt ${attempt}`);
    }
    assert.equal(
      await signIn(site.port, email, "203.0.113.200"),
      429,
      "rotating a client-supplied header must not create a fresh bucket",
    );
  } finally {
    await site.close();
  }
});

test("proxied mode uses the address the trusted proxy appended", async () => {
  const site = await serve(true);
  try {
    const email = `proxy-${randomUUID()}@example.org`;
    const client = "203.0.113.77";

    for (let attempt = 1; attempt <= 8; attempt += 1) {
      assert.equal(
        await signIn(site.port, email, `198.51.100.${attempt}, ${client}`),
        401,
        `attempt ${attempt}`,
      );
    }
    assert.equal(
      await signIn(site.port, email, `192.0.2.200, ${client}`),
      429,
      "a spoofed leftmost entry does not escape the bucket the proxy appended",
    );
    assert.equal(
      await signIn(site.port, email, "203.0.113.78"),
      401,
      "a different client address is a different bucket",
    );
  } finally {
    await site.close();
  }
});

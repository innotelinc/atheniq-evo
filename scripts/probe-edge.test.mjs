/**
 * Which host `probe:edge` asks, and whether it dares ask at all.
 *
 * The probe's whole value is that it reports on the host the app is actually
 * built for. A run against yesterday's name would call a gated host healthy, so
 * the resolution is a plain function and these tests pin its order.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { appBaseFrom, classify, main, mobileBase, resolveBase } from "./probe-edge.mjs";

/** What `mobile/lib/api.ts` compiles in, in miniature. */
const CLIENT = [
  'const RAW_BASE = process.env.EXPO_PUBLIC_API_BASE || "https://console.atheniq.institute";',
  'export const API_BASE = RAW_BASE.replace(/\\/+$/, "");',
  "",
].join("\n");

const dir = mkdtempSync(join(tmpdir(), "probe-edge-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const sources = [
  { argv: ["node", "probe-edge.mjs", "--base", "https://flag.example/"], expect: "--base" },
  { env: { ATHENIQ_PROBE_BASE: "https://probe.example/" }, expect: "ATHENIQ_PROBE_BASE" },
  { env: { EXPO_PUBLIC_API_BASE: "https://env.example/" }, expect: "EXPO_PUBLIC_API_BASE" },
  { appBase: "https://app.example/", expect: "mobile/lib/api.ts" },
];

describe("the app's own base", () => {
  it("reads the default the client compiles in", () => {
    assert.equal(appBaseFrom(CLIENT), "https://console.atheniq.institute");
  });

  it("trims a trailing slash in that default", () => {
    const client = 'process.env.EXPO_PUBLIC_API_BASE || "https://console.atheniq.institute/"';
    assert.equal(appBaseFrom(client), "https://console.atheniq.institute");
  });

  it("finds nothing when the client has no default", () => {
    assert.equal(appBaseFrom("const API_BASE = process.env.EXPO_PUBLIC_API_BASE;"), "");
  });

  it("reads a client from a path, and gives up on a missing one", () => {
    const file = join(dir, "api.ts");
    writeFileSync(file, CLIENT, "utf8");
    assert.equal(mobileBase(file), "https://console.atheniq.institute");
    assert.equal(mobileBase(join(dir, "not-checked-out.ts")), "");
  });
});

describe("where the host comes from", () => {
  it("lets --base beat every environment and the app", () => {
    assert.deepEqual(
      resolveBase({
        argv: ["node", "probe-edge.mjs", "--base", "https://flag.example"],
        env: { ATHENIQ_PROBE_BASE: "https://probe.example", EXPO_PUBLIC_API_BASE: "https://env.example" },
        appBase: "https://app.example",
      }),
      { base: "https://flag.example", source: "--base" },
    );
  });

  it("lets ATHENIQ_PROBE_BASE beat the app's variable and the client", () => {
    assert.deepEqual(
      resolveBase({
        argv: ["node", "probe-edge.mjs"],
        env: { ATHENIQ_PROBE_BASE: "https://probe.example", EXPO_PUBLIC_API_BASE: "https://env.example" },
        appBase: "https://app.example",
      }),
      { base: "https://probe.example", source: "ATHENIQ_PROBE_BASE" },
    );
  });

  it("lets the app's EXPO_PUBLIC_API_BASE beat the client it was compiled from", () => {
    assert.deepEqual(
      resolveBase({
        argv: ["node", "probe-edge.mjs"],
        env: { EXPO_PUBLIC_API_BASE: "https://env.example" },
        appBase: "https://app.example",
      }),
      { base: "https://env.example", source: "EXPO_PUBLIC_API_BASE" },
    );
  });

  it("follows the client when nothing names a host", () => {
    assert.deepEqual(resolveBase({ argv: ["node", "probe-edge.mjs"], env: {}, appBase: "https://app.example" }), {
      base: "https://app.example",
      source: "mobile/lib/api.ts",
    });
  });

  it("trims a trailing slash from whichever source won", () => {
    for (const { expect, ...input } of sources) {
      const resolved = resolveBase({ argv: ["node", "probe-edge.mjs"], env: {}, appBase: "", ...input });
      assert.equal(resolved.source, expect);
      assert.ok(resolved.base.endsWith("example"), `${expect} kept its host`);
      assert.ok(!resolved.base.endsWith("/"), `${expect} was trimmed`);
    }
  });

  it("does not mistake --path for a host", () => {
    assert.deepEqual(
      resolveBase({
        argv: ["node", "probe-edge.mjs", "--path", "/api/mobile/v1/me"],
        env: {},
        appBase: "https://app.example",
      }),
      { base: "https://app.example", source: "mobile/lib/api.ts" },
    );
  });

  it("ignores a --base with no value", () => {
    assert.deepEqual(resolveBase({ argv: ["node", "probe-edge.mjs", "--base"], env: {}, appBase: "https://app.example" }), {
      base: "https://app.example",
      source: "mobile/lib/api.ts",
    });
  });
});

/**
 * One row per gate `classify()` can name, with the response that produces it.
 * The gate is what the operator acts on, so each row is a real answer as well
 * as an evidence string: a wrong gate sends somebody to the wrong config file.
 */
const GATES = [
  {
    name: "nothing at all, below HTTP",
    response: { status: 0, error: "ENOTFOUND" },
    gate: "none",
    evidence: /no response/,
  },
  {
    name: "Authentik's forward auth, on the IdP host",
    response: {
      status: 302,
      location:
        "https://auth.innotel.us/application/o/authorize/?client_id=classroom&redirect_uri=https%3A%2F%2Fregistrar.atheniq.institute%2Fapi%2Fmobile%2Fv1&state=x",
    },
    gate: "authentik",
    evidence: /application\/o\/authorize/,
  },
  {
    name: "Authentik's outpost start URL",
    response: { status: 302, location: "https://auth.innotel.us/outpost.goauthentik.io/start?rd=%2Fapi%2Fmobile%2Fv1" },
    gate: "authentik",
    evidence: /outpost\.goauthentik\.io/,
  },
  {
    name: "the console middleware's own 401",
    response: {
      status: 401,
      contentType: "application/json",
      body: '{"ok":false,"error":"Sign in to use the console."}',
    },
    gate: "console-middleware",
    evidence: /middleware answered 401 JSON/,
  },
  {
    name: "the console middleware's sign-in redirect",
    response: { status: 307, location: "https://console.atheniq.institute/login?next=%2Fapi%2Fcredentials" },
    gate: "console-middleware",
    evidence: /sign-in redirect to /,
  },
  {
    name: "the proxy's own 404 page",
    response: {
      status: 404,
      contentType: "text/html",
      body: "<html><body><h1>404 Not Found</h1><hr><center>openresty</center></body></html>",
    },
    gate: "edge",
    evidence: /the proxy answered 404 itself/,
  },
  {
    name: "the proxy's own 403 page",
    response: {
      status: 403,
      contentType: "text/html",
      body: "<html><body><h1>403 Forbidden</h1><hr><center>nginx</center></body></html>",
    },
    gate: "edge",
    evidence: /the proxy answered 403 itself/,
  },
  {
    name: "the route answering as itself",
    response: { status: 200, contentType: "application/json", body: '{"ok":true}' },
    gate: "app",
    evidence: /the route answered/,
  },
  {
    name: "the route's own 500",
    response: { status: 500, contentType: "application/json", body: '{"ok":false,"error":"boom"}' },
    gate: "app",
    evidence: /the route answered/,
  },
  {
    name: "Authentik ahead of a proxy-shaped body",
    response: {
      status: 302,
      location: "https://auth.innotel.us/application/o/authorize/?client_id=classroom",
      body: "<hr><center>openresty</center>",
    },
    gate: "authentik",
    evidence: /application\/o\/authorize/,
  },
  {
    name: "the middleware ahead of a proxy-shaped body",
    response: {
      status: 401,
      body: '<hr><center>nginx</center>{"error":"Sign in to use the console."}',
    },
    gate: "console-middleware",
    evidence: /middleware answered 401 JSON/,
  },
];

describe("which gate answered", () => {
  for (const { name, response, gate, evidence } of GATES) {
    it(`names ${gate}: ${name}`, () => {
      const result = classify(response);
      assert.equal(result.gate, gate);
      assert.match(result.evidence, evidence);
    });
  }

  it("names every gate the probe knows how to print a fix for", () => {
    assert.deepEqual(
      [...new Set(GATES.map((row) => row.gate))].sort(),
      ["app", "authentik", "console-middleware", "edge", "none"],
    );
  });

  it("defaults the response fields the caller may omit", () => {
    assert.deepEqual(classify({ status: 200 }), { gate: "app", evidence: "the route answered" });
  });
});

describe("refusing to guess", () => {
  it("has no host when nothing names one", () => {
    assert.deepEqual(resolveBase({ argv: ["node", "probe-edge.mjs"], env: {}, appBase: "" }), {
      base: "",
      source: "",
    });
  });

  it("stops with exit 2 and says why, without probing anything", async () => {
    const errors = [];
    const write = console.error;
    console.error = (...args) => errors.push(args.join(" "));
    try {
      assert.equal(await main({ argv: ["node", "probe-edge.mjs"], env: {}, appBase: "" }), 2);
    } finally {
      console.error = write;
    }
    assert.match(errors.join("\n"), /Refusing to guess a host/);
  });
});

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
import { appBaseFrom, main, mobileBase, resolveBase } from "./probe-edge.mjs";

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

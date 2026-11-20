/**
 * The token rules, in isolation.
 *
 * A classroom token is the only thing standing between a learner and someone
 * else's library, so the refusals get their own tests rather than relying on
 * the integration suite to notice a regression.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { signClassroomToken, verifyClassroomToken, signHookBody, verifyHookSignature } from "../src/auth.ts";

const SECRET = "unit-test-secret-that-is-at-least-32";
const base = {
  learnerId: "lrn_1",
  org: "AthenIQ Institute",
  courseKey: "course-v1:Org+Course+Run",
  classroomId: "cls_1",
  ttlSeconds: 900,
};

describe("classroom tokens", () => {
  it("round-trips a learner's claims", () => {
    const { token } = signClassroomToken(base, SECRET);
    const verified = verifyClassroomToken(token, SECRET);
    assert.equal(verified.ok, true);
    if (!verified.ok) return;
    assert.equal(verified.value.sub, "lrn_1");
    assert.equal(verified.value.classroomId, "cls_1");
    assert.equal(verified.value.ver, 1);
  });

  it("refuses a token signed with another secret", () => {
    const { token } = signClassroomToken(base, SECRET);
    const verified = verifyClassroomToken(token, "another-secret-that-is-32-characters");
    assert.equal(verified.ok, false);
  });

  it("refuses a tampered payload", () => {
    const { token } = signClassroomToken(base, SECRET);
    const [header, , signature] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(token.split(".")[1] as string, "base64url").toString()), sub: "lrn_2" }),
    ).toString("base64url");
    const verified = verifyClassroomToken(`${header}.${forged}.${signature}`, SECRET);
    assert.equal(verified.ok, false);
  });

  it("refuses an expired token", () => {
    const past = new Date(Date.now() - 3_600_000);
    const { token } = signClassroomToken({ ...base, now: past }, SECRET);
    const verified = verifyClassroomToken(token, SECRET);
    assert.equal(verified.ok, false);
    if (!verified.ok) assert.match(verified.error, /expired/);
  });

  it("refuses a token minted for another audience", () => {
    const { token } = signClassroomToken(base, SECRET);
    const verified = verifyClassroomToken(token, SECRET, { audience: "someone-else" });
    assert.equal(verified.ok, false);
    if (!verified.ok) assert.match(verified.error, /audience/);
  });

  it("refuses a token from another issuer", () => {
    const { token } = signClassroomToken(base, SECRET);
    const verified = verifyClassroomToken(token, SECRET, { issuer: "https://evil.example" });
    assert.equal(verified.ok, false);
  });

  it("refuses an alg that is not HS256", () => {
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(JSON.stringify({ sub: "lrn_1" })).toString("base64url");
    const verified = verifyClassroomToken(`${header}.${body}.`, SECRET);
    assert.equal(verified.ok, false);
    if (!verified.ok) assert.match(verified.error, /alg/);
  });
});

describe("hook signatures", () => {
  it("accepts a fresh signature over the exact body", () => {
    const raw = JSON.stringify({ a: 1 });
    const ts = String(Math.floor(Date.now() / 1000));
    const verified = verifyHookSignature(SECRET, { signature: signHookBody(SECRET, ts, raw), timestamp: ts }, raw);
    assert.equal(verified.ok, true);
  });

  it("refuses a body that changed after signing", () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const signature = signHookBody(SECRET, ts, JSON.stringify({ a: 1 }));
    const verified = verifyHookSignature(SECRET, { signature, timestamp: ts }, JSON.stringify({ a: 2 }));
    assert.equal(verified.ok, false);
  });

  it("refuses a stale timestamp", () => {
    const raw = "{}";
    const ts = String(Math.floor(Date.now() / 1000) - 600);
    const verified = verifyHookSignature(SECRET, { signature: signHookBody(SECRET, ts, raw), timestamp: ts }, raw);
    assert.equal(verified.ok, false);
    if (!verified.ok) assert.match(verified.error, /stale/);
  });

  it("refuses missing headers", () => {
    const verified = verifyHookSignature(SECRET, { signature: undefined, timestamp: undefined }, "{}");
    assert.equal(verified.ok, false);
  });
});

/**
 * The integration, end to end over real HTTP.
 *
 * Each test drives the bridge the way the console or OpenMAIC does, and asserts
 * on what reached the fake upstreams — because the bug worth catching is a
 * bridge that answers 200 while writing nothing anywhere.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { verifyClassroomToken, signHookBody } from "../src/auth.ts";
import { COURSE_KEY, LEARNER_ID, get, post, startStack, type Stack } from "./fakes.ts";

let stack: Stack;

before(async () => {
  stack = await startStack();
});

after(async () => {
  if (!stack) return;
  await stack.cleanup();
  await stack.bridge.close();
});

function service(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${stack.serviceToken}`, ...extra };
}

function signed(body: unknown): { headers: Record<string, string>; raw: string } {
  const raw = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  return {
    raw,
    headers: {
      "content-type": "application/json",
      "x-atheniq-timestamp": timestamp,
      "x-atheniq-signature": signHookBody(stack.hookSecret, timestamp, raw),
    },
  };
}

async function rawPost(base: string, path: string, raw: string, headers: Record<string, string>) {
  const response = await fetch(`${base}${path}`, { method: "POST", headers, body: raw });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

describe("health", () => {
  it("reports every upstream and the contract version", async () => {
    const { status, body } = await get(`${stack.bridge.url}/health`);
    assert.equal(status, 200);
    const health = body as {
      ok: boolean;
      contract: number;
      checks: { name: string; status: string }[];
    };
    assert.equal(health.ok, true);
    assert.equal(health.contract, 1);
    assert.deepEqual(
      health.checks.map((check) => check.name).sort(),
      ["console", "lms", "omniroute", "openmaic"],
    );
    assert.ok(health.checks.every((check) => check.status === "ok"));
  });
});

describe("service authentication", () => {
  it("refuses a classroom sign-in with no token", async () => {
    const { status } = await post(`${stack.bridge.url}/v1/sso/classroom`, {
      learnerId: LEARNER_ID,
      courseKey: COURSE_KEY,
    });
    assert.equal(status, 401);
  });

  it("refuses a token that is not the service token", async () => {
    const { status } = await post(
      `${stack.bridge.url}/v1/sso/classroom`,
      { learnerId: LEARNER_ID, courseKey: COURSE_KEY },
      { authorization: "Bearer not-the-token" },
    );
    assert.equal(status, 401);
  });
});

describe("classroom sign-in", () => {
  it("mints a token OpenMAIC can verify, pinned to the course and learner", async () => {
    const { status, body } = await post(
      `${stack.bridge.url}/v1/sso/classroom`,
      { learnerId: LEARNER_ID, name: "Ada Learner", email: "ada@atheniq.institute", courseKey: COURSE_KEY },
      service(),
    );
    assert.equal(status, 200);
    const result = body as { token: string; classroomId: string; courseKey: string };

    const verified = verifyClassroomToken(result.token, stack.secret);
    assert.equal(verified.ok, true);
    if (!verified.ok) return;
    assert.equal(verified.value.sub, LEARNER_ID);
    assert.equal(verified.value.courseKey, COURSE_KEY);
    assert.equal(verified.value.classroomId, result.classroomId);
    assert.equal(verified.value.aud, "atheniq-classroom");
    assert.equal(verified.value.role, "learner");
  });

  it("returns the same classroom when a learner reopens the course", async () => {
    const first = await post(
      `${stack.bridge.url}/v1/sso/classroom`,
      { learnerId: LEARNER_ID, courseKey: COURSE_KEY },
      service(),
    );
    const second = await post(
      `${stack.bridge.url}/v1/sso/classroom`,
      { learnerId: LEARNER_ID, courseKey: COURSE_KEY },
      service(),
    );
    assert.equal(
      (first.body as { classroomId: string }).classroomId,
      (second.body as { classroomId: string }).classroomId,
    );
  });

  it("rejects a course key that is not an Open edX key", async () => {
    const { status } = await post(
      `${stack.bridge.url}/v1/sso/classroom`,
      { learnerId: LEARNER_ID, courseKey: "CS101" },
      service(),
    );
    assert.equal(status, 400);
  });
});

describe("classroom generation", () => {
  it("starts the classroom as the learner and records the job", async () => {
    const before = stack.openmaic.calls.length;
    const { status, body } = await post(
      `${stack.bridge.url}/v1/classrooms`,
      {
        courseKey: COURSE_KEY,
        learnerId: LEARNER_ID,
        requirement: "Teach binary search with a worked example and a quiz.",
      },
      service({ "x-atheniq-actor": "stf_registrar" }),
    );
    assert.equal(status, 201);
    const created = body as { classroomId: string; jobId: string; launchUrl: string; token: string };
    assert.equal(created.jobId, "job_abc");
    assert.equal(created.launchUrl, `${stack.openmaic.url}/classroom/stage_xyz`);

    const call = stack.openmaic.calls.slice(before).find((entry) => entry.path === "/api/generate-classroom");
    assert.ok(call, "OpenMAIC was asked to generate the classroom");

    const authorization = call.headers.authorization ?? "";
    assert.match(authorization, /^Bearer /);
    const verified = verifyClassroomToken(authorization.replace("Bearer ", ""), stack.secret);
    assert.equal(verified.ok, true);
    if (verified.ok) {
      assert.equal(verified.value.sub, LEARNER_ID);
      assert.equal(verified.value.courseKey, COURSE_KEY);
      assert.equal(verified.value.classroomId, created.classroomId);
    }
    assert.deepEqual(call.body, {
      requirement: "Teach binary search with a worked example and a quiz.",
    });

    const record = await get(`${stack.bridge.url}/v1/classrooms/${created.classroomId}`, service());
    assert.equal(record.status, 200);
    assert.equal((record.body as { createdBy: string }).createdBy, "stf_registrar");
  });

  it("surfaces an OpenMAIC refusal instead of inventing a classroom", async () => {
    const { status } = await post(
      `${stack.bridge.url}/v1/classrooms`,
      { courseKey: COURSE_KEY, learnerId: LEARNER_ID, requirement: "" },
      service(),
    );
    assert.equal(status, 400);
  });
});

describe("completion fan-out", () => {
  let classroomId: string;

  before(async () => {
    const created = await post(
      `${stack.bridge.url}/v1/classrooms`,
      {
        courseKey: COURSE_KEY,
        learnerId: LEARNER_ID,
        lmsUsername: "ada",
        requirement: "Binary search.",
      },
      service(),
    );
    assert.equal(created.status, 201);
    classroomId = (created.body as { classroomId: string }).classroomId;
  });

  it("writes the completion, the grade, the enrollment and the award", async () => {
    const withGrade = await startStack({ lmsUserMap: { [LEARNER_ID]: 7 } });
    try {
      const created = await post(
        `${withGrade.bridge.url}/v1/classrooms`,
        { courseKey: COURSE_KEY, learnerId: LEARNER_ID, lmsUsername: "ada", requirement: "Binary search." },
        { authorization: `Bearer ${withGrade.serviceToken}` },
      );
      const id = (created.body as { classroomId: string }).classroomId;

      const payload = {
        classroomId: id,
        courseKey: COURSE_KEY,
        learnerId: LEARNER_ID,
        score: 8,
        maxScore: 10,
        outcomes: [{ id: "search-invariant", label: "Explains the loop invariant", mastery: 0.9 }],
        issueCredential: true,
      };
      const { headers, raw } = signed(payload);
      const timestamp = headers["x-atheniq-timestamp"] as string;
      const response = await rawPost(withGrade.bridge.url, "/v1/completions", raw, {
        ...headers,
        "x-atheniq-signature": signHookBody(withGrade.hookSecret, timestamp, raw),
      });
      assert.equal(response.status, 200);
      const result = response.body as {
        replay: boolean;
        grade: { percent: number };
        steps: { step: string; status: string }[];
        credential: { verifyId: string } | null;
      };
      assert.equal(result.replay, false);
      assert.equal(result.grade.percent, 80);
      assert.deepEqual(
        result.steps.map((step) => `${step.step}:${step.status}`),
        [
          "lms-completion:ok",
          "lms-grade:ok",
          "console-completion:ok",
          "credential:ok",
        ],
      );
      assert.equal(result.credential?.verifyId, "ATH-2026-TEST01");

      const completionCall = withGrade.lms.calls.find((call) =>
        call.path.startsWith("/api/completion/v1/completion-batch"),
      );
      assert.deepEqual(completionCall?.body, {
        username: "ada",
        course_key: COURSE_KEY,
        blocks: { "block-v1:InnotelLabs+CS101+2026F+type@sequential+block@ai_classroom": 1 },
        earned: 8,
        possible: 10,
      });

      const gradeCall = withGrade.lms.calls.find((call) =>
        call.path.includes("/api/grades/v1/gradebook/"),
      );
      assert.ok(gradeCall);
      assert.match(gradeCall.path, /bulk-update$/);
      const overrides = gradeCall.body as {
        user_id: number;
        usage_id: string;
        grade: { earned_all_override: number; possible_all_override: number };
      }[];
      assert.equal(overrides[0]?.user_id, 7);
      assert.equal(overrides[0]?.grade.earned_all_override, 8);
      assert.equal(overrides[0]?.grade.possible_all_override, 10);

      const consoleCall = withGrade.console.calls.find(
        (call) => (call.body as { action?: string } | null)?.action === "complete-enrollment",
      );
      assert.ok(consoleCall);
      assert.equal((consoleCall.body as { grade: string }).grade, "80%");
      assert.equal((consoleCall.body as { source: string }).source.startsWith("openmaic:"), true);
    } finally {
      await withGrade.cleanup();
      await withGrade.bridge.close();
    }
  });

  it("replays an identical completion without touching any upstream twice", async () => {
    const body = {
      classroomId,
      courseKey: COURSE_KEY,
      learnerId: LEARNER_ID,
      score: 9,
      maxScore: 10,
      issueCredential: false,
    };
    const first = signed(body);
    const firstTimestamp = first.headers["x-atheniq-timestamp"] as string;
    const firstReply = await rawPost(stack.bridge.url, "/v1/completions", first.raw, {
      ...first.headers,
      "x-atheniq-signature": signHookBody(stack.hookSecret, firstTimestamp, first.raw),
    });
    assert.equal(firstReply.status, 200);
    assert.equal((firstReply.body as { replay: boolean }).replay, false);

    const callsAfterFirst = stack.console.calls.length;

    const second = signed(body);
    const secondTimestamp = second.headers["x-atheniq-timestamp"] as string;
    const secondReply = await rawPost(stack.bridge.url, "/v1/completions", second.raw, {
      ...second.headers,
      "x-atheniq-signature": signHookBody(stack.hookSecret, secondTimestamp, second.raw),
    });
    assert.equal(secondReply.status, 200);
    assert.equal((secondReply.body as { replay: boolean }).replay, true);
    assert.equal(
      (secondReply.body as { completionId: string }).completionId,
      (firstReply.body as { completionId: string }).completionId,
    );
    assert.equal(stack.console.calls.length, callsAfterFirst, "no upstream call on replay");
  });

  it("refuses a callback that is not signed by OpenMAIC", async () => {
    const { headers, raw } = signed({
      classroomId,
      courseKey: COURSE_KEY,
      learnerId: LEARNER_ID,
    });
    const response = await rawPost(stack.bridge.url, "/v1/completions", raw, {
      ...headers,
      "x-atheniq-signature": "0".repeat(64),
    });
    assert.equal(response.status, 401);
  });

  it("refuses a signature replayed outside its window", async () => {
    const raw = JSON.stringify({ classroomId, courseKey: COURSE_KEY, learnerId: LEARNER_ID });
    const stale = String(Math.floor(Date.now() / 1000) - 3600);
    const response = await rawPost(stack.bridge.url, "/v1/completions", raw, {
      "content-type": "application/json",
      "x-atheniq-timestamp": stale,
      "x-atheniq-signature": signHookBody(stack.hookSecret, stale, raw),
    });
    assert.equal(response.status, 401);
  });

  it("refuses a completion for a classroom it never launched", async () => {
    const { headers, raw } = signed({
      classroomId: "cls_unknown",
      courseKey: COURSE_KEY,
      learnerId: LEARNER_ID,
    });
    const response = await rawPost(stack.bridge.url, "/v1/completions", raw, headers);
    assert.equal(response.status, 409);
  });

  it("refuses a completion that names a different course than the classroom", async () => {
    const { headers, raw } = signed({
      classroomId,
      courseKey: "course-v1:InnotelLabs+CS102+2026F",
      learnerId: LEARNER_ID,
    });
    const response = await rawPost(stack.bridge.url, "/v1/completions", raw, headers);
    assert.equal(response.status, 409);
  });

  it("keeps the transcript for the learner", async () => {
    const { status, body } = await get(
      `${stack.bridge.url}/v1/learners/${LEARNER_ID}/transcript`,
      service(),
    );
    assert.equal(status, 200);
    const entries = (body as { entries: { courseKey: string; completedAt: string }[] }).entries;
    assert.ok(entries.length >= 1);
    assert.equal(entries[0]?.courseKey, COURSE_KEY);
  });
});

describe("partial failure and retry", () => {
  it("retries only the step that failed, keeping the LMS write", async () => {
    const flaky = await startStack({ consoleFailsOnce: true });
    try {
      const created = await post(
        `${flaky.bridge.url}/v1/classrooms`,
        { courseKey: COURSE_KEY, learnerId: LEARNER_ID, lmsUsername: "ada", requirement: "Recursion." },
        { authorization: `Bearer ${flaky.serviceToken}` },
      );
      const id = (created.body as { classroomId: string }).classroomId;

      const payload = {
        classroomId: id,
        courseKey: COURSE_KEY,
        learnerId: LEARNER_ID,
        score: 5,
        maxScore: 10,
      };
      const first = signed(payload);
      const ts1 = first.headers["x-atheniq-timestamp"] as string;
      const firstReply = await rawPost(flaky.bridge.url, "/v1/completions", first.raw, {
        ...first.headers,
        "x-atheniq-signature": signHookBody(flaky.hookSecret, ts1, first.raw),
      });
      assert.equal(firstReply.status, 200);
      const failed = firstReply.body as { steps: { step: string; status: string }[]; credential: unknown };
      assert.equal(failed.steps.find((step) => step.step === "lms-completion")?.status, "ok");
      assert.equal(failed.steps.find((step) => step.step === "console-completion")?.status, "failed");

      const completionCallsBefore = flaky.lms.calls.filter((call) =>
        call.path.startsWith("/api/completion/v1/completion-batch"),
      ).length;

      const second = signed(payload);
      const ts2 = second.headers["x-atheniq-timestamp"] as string;
      const retried = await rawPost(flaky.bridge.url, "/v1/completions?retry=1", second.raw, {
        ...second.headers,
        "x-atheniq-signature": signHookBody(flaky.hookSecret, ts2, second.raw),
      });
      assert.equal(retried.status, 200);
      const result = retried.body as { steps: { step: string; status: string }[] };
      assert.equal(result.steps.find((step) => step.step === "console-completion")?.status, "ok");

      const completionCallsAfter = flaky.lms.calls.filter((call) =>
        call.path.startsWith("/api/completion/v1/completion-batch"),
      ).length;
      assert.equal(completionCallsAfter, completionCallsBefore, "the LMS was not written twice");
    } finally {
      await flaky.cleanup();
      await flaky.bridge.close();
    }
  });
});

describe("credentials", () => {
  it("awards through the console and is idempotent", async () => {
    const request = {
      learnerId: LEARNER_ID,
      type: "degree_conferral",
      subjectRef: "prg_bba",
      override: true,
      idempotencyKey: "degree:test:ada",
    };
    const first = await post(`${stack.bridge.url}/v1/credentials`, request, service());
    assert.equal(first.status, 201);
    const awarded = first.body as { verifyId: string };
    assert.equal(awarded.verifyId, "ATH-2026-TEST01");

    const calls = stack.console.calls.length;
    const second = await post(`${stack.bridge.url}/v1/credentials`, request, service());
    assert.equal(second.status, 201);
    assert.equal((second.body as { verifyId: string }).verifyId, awarded.verifyId);
    assert.equal(stack.console.calls.length, calls, "the second award was served from the ledger");
  });
});

describe("gateway", () => {
  it("lists the models OmniRoute offers", async () => {
    const { status, body } = await get(`${stack.bridge.url}/v1/gateway/models`, service());
    assert.equal(status, 200);
    assert.deepEqual((body as { models: string[] }).models, ["auto/best-chat", "gpt-5.5"]);
  });
});

/**
 * The catalog is the console's record of record: one test per rule a registrar
 * depends on — a unique code, a published course that students can register for,
 * an edit that reaches credits and registration, a removal that cannot orphan an
 * enrollment, and a sync that reports what the LMS actually serves.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { Catalog, coerceGrading, coerceModules } from "../src/catalog.ts";
import { generateDraft, rulesDraft, suggestCode } from "../src/ai.ts";
import { loadConfig } from "../src/config.ts";
import { COURSES } from "../src/content.ts";
import { Registry } from "../src/registry.ts";
import { Store } from "../src/store.ts";
import { fetchLmsCatalog } from "../src/sync.ts";

function config(extra: Record<string, string> = {}) {
  return loadConfig({
    NODE_ENV: "test",
    SESSION_SECRET: "s".repeat(48),
    REGISTRAR_EMAIL: "registrar@atheniq.institute",
    REGISTRAR_PASSWORD: "atheniq-registrar",
    INSTITUTION_SEED_DEMO: "false",
    ...extra,
  });
}

function build() {
  const catalog = Catalog.inMemory();
  const store = Store.inMemory();
  const registry = new Registry(store, config(), catalog);
  return { catalog, registry, store };
}

const draftInput = {
  code: "AI999",
  title: "Applied Evaluation",
  termId: "2027A",
  credits: 15,
  instructor: "Dr. Amara Okonjo",
  format: "Studio · 12 weeks",
  seats: 20,
  weeks: 12,
  summary:
    "An evaluation studio: design a measurement that survives contact with users, then defend the stopping rule you chose.",
  status: "draft" as const,
};

test("a fresh catalog is seeded from the published curriculum", () => {
  const catalog = Catalog.inMemory();
  assert.equal(catalog.all().length, COURSES.length);
  assert.ok(catalog.all().every((course) => course.status === "published"));
  assert.equal(catalog.byCode("AI101")?.title, "Foundations of Machine Intelligence");
});

test("a course code is unique and looks like a code", () => {
  const { catalog } = build();
  const duplicate = catalog.create({ ...draftInput, code: "AI101" });
  assert.equal(duplicate.ok, false);

  const malformed = catalog.create({ ...draftInput, code: "AI" });
  assert.equal(malformed.ok, false);
  if (!malformed.ok) assert.ok(malformed.fields?.code);
});

test("a created course gets the runtime key the LMS will be asked for", () => {
  const { catalog } = build();
  const created = catalog.create(draftInput);
  assert.ok(created.ok);
  if (!created.ok) return;
  assert.equal(created.value.key, "course-v1:AthenIQ+AI999+2027A");
  assert.equal(created.value.status, "draft");
  assert.equal(catalog.byCode("AI999")?.source, "catalog");
});

test("a draft is not open for registration, and publishing opens it", () => {
  const { catalog, registry } = build();
  assert.ok(catalog.create(draftInput).ok);

  const student = admission(registry);
  const refused = registry.register(student, "AI999");
  assert.equal(refused.ok, false);

  assert.ok(catalog.setStatus("AI999", "published").ok);
  const registered = registry.register(student, "AI999");
  assert.ok(registered.ok);
  assert.equal(catalog.byCode("AI999")?.seats, 20);
});

test("an edit reaches the seat rules and a student's credits", () => {
  const { catalog, registry, store } = build();
  const student = admission(registry);
  assert.ok(registry.register(student, "AI101").ok);

  // Complete the enrollment the way the registrar or the bridge does.
  store.mutate((data) => {
    for (const enrollment of data.enrollments) enrollment.status = "completed";
  });
  assert.equal(registry.creditsEarned(student), 15);

  const edited = catalog.update("AI101", {
    ...draftInput,
    code: "AI101",
    title: "Foundations of Machine Intelligence",
    credits: 20,
  });
  assert.ok(edited.ok);
  assert.equal(registry.creditsEarned(student), 20);
});

test("a course with an enrollment is reported as unremovable", () => {
  const { catalog, registry } = build();
  const student = admission(registry);
  assert.ok(registry.register(student, "AI101").ok);
  assert.equal(registry.enrollmentsForCourse("AI101"), 1);

  const clean = catalog.create({ ...draftInput, code: "AI998" });
  assert.ok(clean.ok);
  assert.equal(registry.enrollmentsForCourse("AI998"), 0);
  assert.ok(catalog.remove("AI998").ok);
  assert.equal(catalog.byCode("AI998"), undefined);
});

test("a classroom reference is stored on the course, not in a second table", () => {
  const { catalog } = build();
  const saved = catalog.setClassroom("AI101", {
    classroomId: "cls_test",
    stageId: "stage_1",
    jobId: "job_1",
    createdAt: new Date().toISOString(),
  });
  assert.ok(saved.ok);
  assert.equal(catalog.byCode("AI101")?.classroom?.stageId, "stage_1");
});

test("the sync matches by course code and reports drift in both directions", () => {
  const { catalog } = build();
  catalog.recordSync(
    {
      at: new Date().toISOString(),
      keys: ["course-v1:AthenIQ+AI101+2027A", "course-v1:InnotelLabs+ACCT201+2027_T1"],
      codes: ["AI101", "ACCT201"],
      external: [{ code: "ACCT201", title: "Financial Accounting", key: "course-v1:InnotelLabs+ACCT201+2027_T1" }],
    },
    null,
  );
  const state = catalog.syncState();
  assert.deepEqual(state.live, ["AI101"]);
  assert.ok(state.missing.includes("AI102"));
  assert.equal(state.external.length, 1);
  assert.equal(state.external[0]?.code, "ACCT201");
  assert.equal(catalog.isLive("AI101"), true);
  assert.equal(catalog.isLive("AI102"), false);
});

test("a failed sync keeps the last good picture and records the reason", () => {
  const { catalog } = build();
  catalog.recordSync(
    { at: "2026-01-01T00:00:00.000Z", keys: [], codes: ["AI101"], external: [] },
    null,
  );
  catalog.recordSyncError("The LMS catalog answered HTTP 502.");
  const state = catalog.syncState();
  assert.equal(state.at, "2026-01-01T00:00:00.000Z");
  assert.equal(state.error, "The LMS catalog answered HTTP 502.");
  assert.deepEqual(state.live, ["AI101"]);
});

test("the LMS catalog is read from the endpoint atheniq.courses serves", async () => {
  const seen: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    seen.push(String(input));
    return new Response(
      JSON.stringify({
        results: [
          { id: "course-v1:InnotelLabs+ACCT201+2027_T1", name: "ACCT201 — Financial Accounting", number: "ACCT201" },
          { id: "course-v1:InnotelLabs+FASH101+2027_T1", name: "FASH101 — Fashion Business", number: "FASH101" },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;

  const result = await fetchLmsCatalog(config({ LMS_BASE_URL: "https://atheniq.courses" }), fetcher);
  assert.equal(result.ok, true);
  assert.equal(result.courses.length, 2);
  assert.equal(result.courses[0]?.code, "ACCT201");
  assert.equal(result.courses[0]?.title, "Financial Accounting");
  assert.ok(seen[0]?.includes("/api/courses/v1/courses/"));
});

test("an unconfigured LMS is reported, never thrown", async () => {
  const result = await fetchLmsCatalog(config(), (async () => new Response("", { status: 500 })) as unknown as typeof fetch);
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /LMS_BASE_URL/);
});

test("the rules engine writes a complete publishable outline without a gateway", () => {
  const draft = rulesDraft("a practical course on data engineering for nurses");
  assert.ok(draft.modules.length >= 3);
  assert.equal(draft.grading.reduce((sum, part) => sum + part.weight, 0), 100);
  assert.ok(draft.outcomes.length >= 3);
  assert.ok(draft.summary.length >= 40);
  assert.ok(draft.modules.every((module) => module.lessons.length > 0));
});

test("generation falls back to the rules when no gateway key is configured", async () => {
  const result = await generateDraft(config(), "a course on clinical data quality");
  assert.equal(result.engine, "rules");
  assert.match(result.note, /rules/);
});

test("generation accepts a gateway reply and rejects a malformed one", async () => {
  const draft = rulesDraft("a course on clinical data quality");
  const good = (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(draft) } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

  const accepted = await generateDraft(
    config({ OMNIROUTE_BASE_URL: "https://gateway.example/v1", OMNIROUTE_API_KEY: "k".repeat(16) }),
    "a course on clinical data quality",
    good,
  );
  assert.equal(accepted.engine, "gateway");
  assert.equal(accepted.draft.title, draft.title);

  const bad = (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: "not json" } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
  const fallback = await generateDraft(
    config({ OMNIROUTE_BASE_URL: "https://gateway.example/v1", OMNIROUTE_API_KEY: "k".repeat(16) }),
    "a course on clinical data quality",
    bad,
  );
  assert.equal(fallback.engine, "rules");
  assert.match(fallback.note, /did not answer/);
});

test("structure coercion drops junk instead of failing the form", () => {
  const modules = coerceModules([
    { title: "Real module", lessons: [{ title: "Lesson", type: "lab", minutes: 30 }, { nope: true }] },
    "not a module",
  ]);
  assert.equal(modules.length, 1);
  assert.equal(modules[0]?.lessons.length, 1);
  assert.deepEqual(coerceGrading([{ component: "Practice", weight: 40 }, { component: "Bad", weight: 500 }]), [
    { component: "Practice", weight: 40 },
  ]);
});

test("the next code follows the department prefix and the highest number", () => {
  const { catalog } = build();
  assert.equal(suggestCode(catalog.all(), "AI"), "AI401");
  assert.equal(suggestCode(catalog.all(), "Nursing"), "NUR101");
});

function admission(registry: Registry): string {
  const application = registry.createApplication({
    firstName: "Ada",
    lastName: "Lovelace",
    email: `ada.${Math.random().toString(36).slice(2, 8)}@example.com`,
    country: "United Kingdom",
    programSlug: "bsc-applied-ai",
    termId: "2027A",
    statement:
      "I have spent four years building scheduling software for a regional health service and want the mathematics to reason about it properly.",
    consent: "on",
  });
  assert.ok(application.ok);
  if (!application.ok) throw new Error("application refused");
  const admitted = registry.decide(application.value.id, "admit", "");
  assert.ok(admitted.ok);
  if (!admitted.ok || !admitted.value.student) throw new Error("admission refused");
  return admitted.value.student.id;
}

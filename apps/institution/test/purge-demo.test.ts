/**
 * Demo provenance and the purge command.
 *
 * The marker matters because a real applicant can share a name with the seed;
 * only the marker and the seed's fixed ids identify demonstration data. The CLI
 * test proves the two safety properties an operator relies on: a dry run writes
 * nothing, and a real run leaves a usable backup. The CLI lives in `src/` so the
 * same file can run inside the container against the Compose data volume.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { purgeDemo } from "../src/purge.ts";
import type { Application, Enrollment, StoreData, Student } from "../src/store.ts";

const NOW = "2026-11-26T12:00:00.000Z";

/** The registry's student shape, including the session field it now writes. */
function student(id: string, provenance?: "demo"): Student & { sessionVersion: number } {
  return {
    id,
    ...(provenance ? { provenance } : {}),
    number: `ATH-2026-${id.endsWith("0001") ? "0001" : "0002"}`,
    firstName: provenance ? "Nadia" : "Real",
    lastName: provenance ? "Rahman" : "Student",
    personalEmail: `${id}@example.com`,
    schoolEmail: `${id}@atheniq.institute`,
    passwordHash: "scrypt$placeholder",
    mustChangePassword: false,
    sessionVersion: 0,
    programSlug: "msc-machine-intelligence",
    termId: "2027A",
    status: "active",
    createdAt: NOW,
    mailbox: {
      address: `${id}@atheniq.institute`,
      status: "reserved",
      provider: "local",
      provisionedAt: NOW,
    },
  };
}

function application(id: string, provenance?: "demo"): Application {
  return {
    id,
    ...(provenance ? { provenance } : {}),
    firstName: "Applicant",
    lastName: "Example",
    email: `${id}@example.com`,
    country: "Germany",
    programSlug: "bsc-applied-ai",
    termId: "2027A",
    statement: "A statement long enough to look like a real application, kept only for this test.",
    status: "submitted",
    submittedAt: NOW,
  };
}

function enrollment(id: string, studentId: string, provenance?: "demo"): Enrollment {
  return {
    id,
    ...(provenance ? { provenance } : {}),
    studentId,
    courseCode: "AI101",
    termId: "2027A",
    status: "registered",
    registeredAt: NOW,
  };
}

function fixture(): StoreData {
  return {
    version: 1,
    counters: { student: 2 },
    applications: [application("app_demo0001", "demo"), application("app_live0001")],
    students: [student("lrn_demo0001", "demo"), student("lrn_live0001")],
    enrollments: [
      enrollment("enr_demo_student", "lrn_demo0001", "demo"),
      enrollment("enr_marked_on_real", "lrn_live0001", "demo"),
      enrollment("enr_live", "lrn_live0001"),
    ],
  };
}

test("purge removes marked demo records and their enrollments, leaving counters alone", () => {
  const data = fixture();
  const dry = purgeDemo(data, true);
  assert.deepEqual(dry.removed, { applications: 1, students: 1, enrollments: 2 });
  assert.equal(dry.changed, true);
  assert.equal(data.students.length, 2, "a dry run must not mutate the registry");

  const applied = purgeDemo(data);
  assert.deepEqual(applied.removed, { applications: 1, students: 1, enrollments: 2 });
  assert.deepEqual(
    applied.data.students.map((item) => item.id),
    ["lrn_live0001"],
  );
  assert.deepEqual(
    applied.data.applications.map((item) => item.id),
    ["app_live0001"],
  );
  assert.deepEqual(
    applied.data.enrollments.map((item) => item.id),
    ["enr_live"],
  );
  assert.deepEqual(applied.data.counters, data.counters, "student numbers stay monotonic");

  const again = purgeDemo(applied.data);
  assert.equal(again.changed, false);
  assert.deepEqual(again.removed, { applications: 0, students: 0, enrollments: 0 });
});

test("purge recognises unmarked volumes from before the provenance field", () => {
  const legacy = fixture();
  const demoStudent = legacy.students.find((item) => item.id === "lrn_demo0001");
  const demoApplication = legacy.applications.find((item) => item.id === "app_demo0001");
  assert.ok(demoStudent);
  assert.ok(demoApplication);
  delete demoStudent.provenance;
  delete demoApplication.provenance;

  const applied = purgeDemo(legacy);
  assert.deepEqual(applied.removed, { applications: 1, students: 1, enrollments: 2 });
  assert.deepEqual(
    applied.data.students.map((item) => item.id),
    ["lrn_live0001"],
  );
  assert.deepEqual(
    applied.data.applications.map((item) => item.id),
    ["app_live0001"],
  );
  assert.deepEqual(
    applied.data.enrollments.map((item) => item.id),
    ["enr_live"],
    "a marked enrollment on a real student still goes, and the legacy student's enrollment goes by reference",
  );
});

test("the CLI dry-runs without writing, backs up before writing, and does nothing on a second run", () => {
  const directory = mkdtempSync(join(tmpdir(), "atheniq-purge-"));
  const file = join(directory, "registry.json");
  const script = resolve("apps/institution/src/purge-cli.ts");
  try {
    const original = `${JSON.stringify(fixture(), null, 2)}\n`;
    writeFileSync(file, original);

    const dry = execFileSync(process.execPath, [script, "--data-dir", directory, "--dry-run"], {
      encoding: "utf8",
    });
    assert.match(dry, /would remove applications: 1, students: 1, enrollments: 2/);
    assert.equal(readFileSync(file, "utf8"), original);
    assert.deepEqual(readdirSync(directory), ["registry.json"], "a dry run creates no backup");

    const applied = execFileSync(process.execPath, [script, "--data-dir", directory], {
      encoding: "utf8",
    });
    assert.match(applied, /removed applications: 1, students: 1, enrollments: 2/);
    const backups = readdirSync(directory).filter((name) => name.startsWith("registry.json.bak-"));
    assert.equal(backups.length, 1);
    assert.equal(readFileSync(join(directory, backups[0] as string), "utf8"), original);

    const cleaned = JSON.parse(readFileSync(file, "utf8")) as StoreData;
    assert.deepEqual(
      cleaned.students.map((item) => item.id),
      ["lrn_live0001"],
    );

    const countBefore = readdirSync(directory).length;
    const second = execFileSync(process.execPath, [script, "--data-dir", directory], {
      encoding: "utf8",
    });
    assert.match(second, /nothing to purge/);
    assert.equal(readdirSync(directory).length, countBefore, "a clean volume gains no backup");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

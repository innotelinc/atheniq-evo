/**
 * The lifecycle that matters: an application becomes a person, the person gets
 * an account and an address they can sign in with, and a seat is held exactly
 * once. These run against the registry, not HTTP: the router is exercised by
 * hand in the runbook's smoke test.
 */

import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { hashPassword, signSession, verifyPassword, verifySession } from "../src/auth.ts";
import { loadConfig } from "../src/config.ts";
import { COURSES, PROGRAMS, applicationCycle, courseByCode, openApplicationTerms } from "../src/content.ts";
import { Registry } from "../src/registry.ts";
import { createInstitutionServer } from "../src/server.ts";
import { Store } from "../src/store.ts";

function config() {
  return loadConfig({
    NODE_ENV: "test",
    SESSION_SECRET: "s".repeat(48),
    REGISTRAR_EMAIL: "registrar@atheniq.institute",
    REGISTRAR_PASSWORD: "atheniq-registrar",
    INSTITUTION_SEED_DEMO: "false",
    PUBLIC_ORIGIN: "http://localhost:8080",
  });
}

function application(overrides: Record<string, string> = {}) {
  return {
    firstName: "Ada",
    lastName: "Lovelace",
    email: "ada@example.com",
    country: "United Kingdom",
    programSlug: "bsc-applied-ai",
    termId: "2027A",
    statement:
      "I have spent four years building scheduling software for a regional health service and want the mathematics to reason about it properly.",
    consent: "on",
    ...overrides,
  };
}

function build() {
  const store = Store.inMemory();
  const registry = new Registry(store, config());
  return { store, registry };
}

test("every course in every curriculum exists in the catalog", () => {
  for (const program of PROGRAMS) {
    for (const block of program.curriculum) {
      for (const code of block.courses) {
        assert.ok(courseByCode(code), `${program.slug} references missing course ${code}`);
      }
    }
  }
  const codes = COURSES.map((course) => course.code);
  assert.equal(new Set(codes).size, codes.length, "course codes are unique");
});

test("an application with a short statement is refused with a field error", () => {
  const { registry } = build();
  const result = registry.createApplication(application({ statement: "Too short." }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.fields?.statement);
  assert.match(result.error, /correct the highlighted fields/i);
});

test("an application for a non-intake term is refused", () => {
  const { registry } = build();
  const result = registry.createApplication(application({ termId: "2028C" }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.fields?.termId);
});

test("the same person cannot submit the same application twice", () => {
  const { registry } = build();
  const first = registry.createApplication(application());
  assert.equal(first.ok, true);
  const second = registry.createApplication(application());
  assert.equal(second.ok, false);
  if (second.ok) return;
  assert.match(second.error, /already have an application/i);
});

test("admission issues a student number, a mailbox and a working password", () => {
  const { registry } = build();
  const created = registry.createApplication(application());
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const admitted = registry.decide(created.value.id, "admit", "Interview complete.");
  assert.equal(admitted.ok, true);
  if (!admitted.ok) return;

  const student = admitted.value.student;
  const tempPassword = admitted.value.tempPassword;
  assert.ok(student);
  assert.ok(tempPassword);
  if (!student || !tempPassword) return;

  assert.match(student.number, /^ATH-\d{4}-0001$/);
  assert.equal(student.schoolEmail, "ada.lovelace@atheniq.institute");
  assert.equal(student.mailbox.address, student.schoolEmail);
  assert.equal(student.mailbox.status, "reserved");
  assert.equal(student.mustChangePassword, true);
  assert.match(tempPassword, /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);

  const signIn = registry.signIn(student.schoolEmail, tempPassword);
  assert.equal(signIn.ok, true, "the temporary password must work");
  assert.equal(registry.student(student.id)?.mustChangePassword, true);

  // The application and the student are linked in one decision.
  assert.equal(registry.application(created.value.id)?.studentId, student.id);
  assert.equal(registry.application(created.value.id)?.status, "admitted");
});

test("a second student with the same name gets a distinct address", () => {
  const { registry } = build();
  const first = registry.createApplication(application());
  assert.equal(first.ok, true);
  if (!first.ok) return;
  registry.decide(first.value.id, "admit", "");

  const second = registry.createApplication(application({ email: "ada.two@example.com" }));
  assert.equal(second.ok, true);
  if (!second.ok) return;
  const admitted = registry.decide(second.value.id, "admit", "");
  assert.equal(admitted.ok, true);
  if (!admitted.ok) return;

  assert.equal(admitted.value.student?.schoolEmail, "ada.lovelace2@atheniq.institute");
  assert.match(admitted.value.student?.number ?? "", /^ATH-\d{4}-0002$/);
});

test("a declined application creates no account", () => {
  const { registry, store } = build();
  const created = registry.createApplication(application());
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const declined = registry.decide(created.value.id, "deny", "Not enough evidence yet.");
  assert.equal(declined.ok, true);
  assert.equal(store.read().students.length, 0);
  assert.equal(registry.application(created.value.id)?.status, "denied");

  const again = registry.decide(created.value.id, "admit", "");
  assert.equal(again.ok, true, "a declined application may still be admitted later");
});

test("changing a password clears the forced-change flag and retires the old one", () => {
  const { registry } = build();
  const created = registry.createApplication(application());
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const admitted = registry.decide(created.value.id, "admit", "");
  assert.equal(admitted.ok, true);
  if (!admitted.ok || !admitted.value.student || !admitted.value.tempPassword) return;

  const student = admitted.value.student;
  const tempPassword = admitted.value.tempPassword;

  const short = registry.changePassword(student.id, tempPassword, "short");
  assert.equal(short.ok, false);

  const changed = registry.changePassword(student.id, tempPassword, "a-much-longer-password");
  assert.equal(changed.ok, true);
  assert.equal(registry.student(student.id)?.mustChangePassword, false);
  assert.equal(registry.signIn(student.schoolEmail, tempPassword).ok, false);
  assert.equal(registry.signIn(student.schoolEmail, "a-much-longer-password").ok, true);
});

test("registration holds one seat and refuses a duplicate", () => {
  const { registry } = build();
  const created = registry.createApplication(application());
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const admitted = registry.decide(created.value.id, "admit", "");
  assert.equal(admitted.ok, true);
  if (!admitted.ok || !admitted.value.student) return;
  const student = admitted.value.student;

  const first = registry.register(student.id, "AI101");
  assert.equal(first.ok, true);
  assert.equal(registry.seatsTaken("AI101"), 1);

  const duplicate = registry.register(student.id, "AI101");
  assert.equal(duplicate.ok, false);
  if (duplicate.ok) return;
  assert.match(duplicate.error, /already registered/i);
  assert.equal(registry.seatsTaken("AI101"), 1);
});

test("a full studio refuses another registration", () => {
  const { registry, store } = build();
  const created = registry.createApplication(application());
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const admitted = registry.decide(created.value.id, "admit", "");
  assert.equal(admitted.ok, true);
  if (!admitted.ok || !admitted.value.student) return;

  const course = courseByCode("AI101");
  assert.ok(course);
  if (!course) return;

  store.mutate((data) => {
    for (let index = 0; index < course.seats; index += 1) {
      data.enrollments.push({
        id: `enr_fill_${index}`,
        studentId: `lrn_fill_${index}`,
        courseCode: course.code,
        termId: course.termId,
        status: "registered",
        registeredAt: new Date().toISOString(),
      });
    }
  });

  const result = registry.register(admitted.value.student.id, course.code);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /full/i);
});

test("a waitlisted term does not accept registration", () => {
  const { registry } = build();
  const created = registry.createApplication(application());
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const admitted = registry.decide(created.value.id, "admit", "");
  assert.equal(admitted.ok, true);
  if (!admitted.ok || !admitted.value.student) return;

  const result = registry.register(admitted.value.student.id, "AI400");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /waitlist/i);
});

test("an application before the intake opens is refused with the opening date", () => {
  const { registry } = build();
  const result = registry.createApplication(
    application({ termId: "2028B" }),
    new Date("2026-11-20T12:00:00Z"),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.fields?.termId ?? "", /open on May 1, 2027/);
});

test("an application after the intake closes is refused with the closing date", () => {
  const { registry } = build();
  const result = registry.createApplication(application(), new Date("2027-05-01T00:00:00Z"));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.fields?.termId ?? "", /closed on April 30, 2027/);
});

test("the final day of an application window is still open", () => {
  const { registry } = build();
  const result = registry.createApplication(application(), new Date("2027-04-30T23:59:00Z"));
  assert.equal(result.ok, true);
});

test("registration after the term deadline is refused", () => {
  const { registry } = build();
  const created = registry.createApplication(application(), new Date("2026-11-20T12:00:00Z"));
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const admitted = registry.decide(created.value.id, "admit", "", new Date("2026-11-21T12:00:00Z"));
  assert.equal(admitted.ok, true);
  if (!admitted.ok || !admitted.value.student) return;

  const result = registry.register(admitted.value.student.id, "AI101", new Date("2027-09-01T00:00:00Z"));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /closed on August 28, 2027/);

  const lastDay = registry.register(admitted.value.student.id, "AI101", new Date("2027-08-28T23:59:00Z"));
  assert.equal(lastDay.ok, true, "the registration deadline is inclusive of its final day");
});

test("the application cycle is derived from the term dates", () => {
  assert.equal(applicationCycle(new Date("2026-11-20T12:00:00Z")).name, "Fall 2027");
  assert.equal(applicationCycle(new Date("2027-06-01T12:00:00Z")).name, "Spring 2028");
  assert.deepEqual(
    openApplicationTerms(new Date("2026-11-20T12:00:00Z")).map((term) => term.id),
    ["2027A"],
  );
});

test("password hashes are salted and verifiable", () => {
  const first = hashPassword("the-same-password");
  const second = hashPassword("the-same-password");
  assert.notEqual(first, second);
  assert.equal(verifyPassword("the-same-password", first), true);
  assert.equal(verifyPassword("another-password", first), false);
  assert.equal(verifyPassword("anything", "not-a-hash"), false);
});

test("a session is bound to its role and refuses tampering", () => {
  const secret = "s".repeat(48);
  const now = new Date("2026-11-20T12:00:00Z");
  const token = signSession(
    { sub: "lrn_demo", role: "student", exp: Math.floor(now.getTime() / 1000) + 60, ver: 0 },
    secret,
  );

  assert.equal(verifySession(token, secret, "student", now)?.sub, "lrn_demo");
  assert.equal(verifySession(token, secret, "registrar", now), null, "a student token is not a staff token");
  assert.equal(verifySession(`${token.slice(0, -1)}x`, secret, "student", now), null, "a changed signature is refused");

  const expired = signSession(
    { sub: "lrn_demo", role: "student", exp: Math.floor(now.getTime() / 1000) - 1, ver: 0 },
    secret,
  );
  assert.equal(verifySession(expired, secret, "student", now), null);
});

test("a password change and a registrar reset revoke existing sessions", async (t) => {
  const store = Store.inMemory();
  const cfg = config();
  const registry = new Registry(store, cfg);
  const created = registry.createApplication(application(), new Date("2026-11-20T12:00:00Z"));
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const admitted = registry.decide(created.value.id, "admit", "", new Date("2026-11-20T12:00:00Z"));
  assert.equal(admitted.ok, true);
  if (!admitted.ok || !admitted.value.student || !admitted.value.tempPassword) return;

  const student = admitted.value.student;
  const tempPassword = admitted.value.tempPassword;
  const server = createInstitutionServer({ config: cfg, registry, mailer: null });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const signIn = async (password: string): Promise<string> => {
    const response = await fetch(`${base}/portal/signin`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: student.schoolEmail, password }).toString(),
      redirect: "manual",
    });
    assert.equal(response.status, 303, "sign-in redirects on success");
    const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    assert.match(cookie, /^atheniq_student=/);
    return cookie;
  };
  const portalStatus = async (cookie: string): Promise<number> => {
    const response = await fetch(`${base}/portal/password`, { headers: { cookie }, redirect: "manual" });
    return response.status;
  };

  const firstCookie = await signIn(tempPassword);
  assert.equal(await portalStatus(firstCookie), 200);
  assert.equal(registry.student(student.id)?.sessionVersion, 0);

  const change = await fetch(`${base}/portal/password`, {
    method: "POST",
    headers: {
      cookie: firstCookie,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      current: tempPassword,
      next: "a-much-longer-password",
      confirm: "a-much-longer-password",
    }).toString(),
    redirect: "manual",
  });
  assert.equal(change.status, 303);
  assert.equal(registry.student(student.id)?.sessionVersion, 1);
  assert.equal(await portalStatus(firstCookie), 303, "the session from before the change is revoked");

  const secondCookie = (change.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  assert.match(secondCookie, /^atheniq_student=/);
  assert.equal(await portalStatus(secondCookie), 200, "the response reissues a current session");

  const reset = registry.resetAccess(student.id);
  assert.equal(reset.ok, true);
  assert.equal(registry.student(student.id)?.sessionVersion, 2);
  assert.equal(await portalStatus(secondCookie), 303, "a registrar reset revokes the current session");
});

test("the seeded preview student can sign in and has a reserved mailbox", () => {
  const store = Store.inMemory(true);
  const registry = new Registry(store, config());
  const result = registry.signIn("nadia.rahman@atheniq.institute", "atheniq-demo");
  assert.equal(result.ok, true);
  if (!result.ok || !result.value) return;
  assert.equal(result.value.mailbox.status, "reserved");
  assert.match(result.value.number, /^ATH-\d{4}-0001$/);
});

test("an activated mailbox records the provider timestamp", () => {
  const { registry } = build();
  const created = registry.createApplication(application());
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const admitted = registry.decide(created.value.id, "admit", "");
  assert.equal(admitted.ok, true);
  if (!admitted.ok || !admitted.value.student) return;

  const activated = registry.activateMailbox(admitted.value.student.id, new Date("2026-11-20T12:00:00Z"));
  assert.equal(activated?.mailbox.status, "active");
  assert.equal(activated?.mailbox.activatedAt, "2026-11-20T12:00:00.000Z");
});

test("stalwart requires a URL and an API key", () => {
  const base = {
    NODE_ENV: "test",
    SESSION_SECRET: "s".repeat(48),
    REGISTRAR_EMAIL: "registrar@atheniq.institute",
    REGISTRAR_PASSWORD: "atheniq-registrar",
    MAIL_PROVIDER: "stalwart",
  };
  assert.throws(() => loadConfig(base), /STALWART_URL/);
  assert.throws(() => loadConfig({ ...base, STALWART_URL: "https://mail.innotel.us" }), /STALWART_TOKEN/);

  const configured = loadConfig({
    ...base,
    STALWART_URL: "https://mail.innotel.us/",
    STALWART_TOKEN: "API_test_token_value",
    STALWART_QUOTA_BYTES: "1073741824",
  });
  assert.equal(configured.mailProvider, "stalwart");
  assert.equal(configured.stalwartUrl, "https://mail.innotel.us");
  assert.equal(configured.stalwartQuotaBytes, 1_073_741_824);
});

test("an unknown mail provider is refused", () => {
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: "test",
        SESSION_SECRET: "s".repeat(48),
        REGISTRAR_EMAIL: "registrar@atheniq.institute",
        REGISTRAR_PASSWORD: "atheniq-registrar",
        MAIL_PROVIDER: "postfix",
      }),
    /MAIL_PROVIDER must be local or stalwart/,
  );
});

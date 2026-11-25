/**
 * One process, two hostnames.
 *
 *   atheniq.institute          → the public site and the student portal
 *   registrar.atheniq.institute → the registrar
 *
 * The surface is decided by `Host` (or a trusted `X-Forwarded-Host`), never by
 * a path a visitor can type. A student cookie cannot open the registrar, and a
 * registrar cookie cannot open a student's record: the cookie names and the
 * signed roles differ.
 *
 * No framework. The route table is small enough to read in one screen, which is
 * the point: every path that mutates a record is visible here.
 */

import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { Catalog, coerceGrading, coerceModules, type CourseInput } from "./catalog.ts";
import { coerceDraft, generateDraft, suggestCode } from "./ai.ts";
import { programBySlug } from "./content.ts";
import { fetchLmsCatalog } from "./sync.ts";
import { signInToClassroom, stageFrom, startClassroom } from "./classroom.ts";
import {
  AttemptLimiter,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  STAFF_COOKIE,
  clearCookie,
  parseCookies,
  safeEqual,
  sessionCookie,
  signSession,
  verifyPassword,
  verifySession,
} from "./auth.ts";
import type { InstitutionConfig } from "./config.ts";
import { fetchTranscript } from "./bridge.ts";
import { createMailer, type Mailer } from "./mail.ts";
import type { Registry } from "./registry.ts";
import type { Student } from "./store.ts";
import { esc, layout, type Surface, type UiContext, type Viewer } from "./ui.ts";\r\nimport { handle: setupHandler } from "./views/setup.ts";
import {
  about,
  academics,
  admissions,
  applicationReceived,
  applyForm,
  home,
  notFound,
  programPage,
  verify,
} from "./views/public.ts";
import { accessibility, privacy, terms } from "./views/legal.ts";
import { account, dashboard, password, record, register, signIn as portalSignIn } from "./views/portal.ts";
import {
  applicationDetail,
  applications,
  dashboard as registrarDashboard,
  signIn as registrarSignIn,
  studentDetail,
  students,
} from "./views/registrar.ts";
import {
  classroom as classroomView,
  courseForm,
  courseValues,
  generateForm,
  generatePreview,
  index as coursesIndex,
} from "./views/courses.ts";

const MAX_BODY_BYTES = 64 * 1024;
const SERVICE = "atheniq-institution";
const ASSETS: Record<string, { type: string; body: Buffer }> = {
  "styles.css": { type: "text/css; charset=utf-8", body: readFileSync(new URL("../public/styles.css", import.meta.url)) },
  "app.js": { type: "text/javascript; charset=utf-8", body: readFileSync(new URL("../public/app.js", import.meta.url)) },
  "mark.svg": { type: "image/svg+xml", body: readFileSync(new URL("../public/mark.svg", import.meta.url)) },
};

interface Reply {
  status: number;
  body: string;
  headers?: Record<string, string>;
  cookies?: string[];
}

interface RequestContext {
  config: InstitutionConfig;
  registry: Registry;
  url: URL;
  body: URLSearchParams;
  ip: string;
  student: Student | null;
  mailer: Mailer | null;
  fetcher: typeof fetch;
  params: Record<string, string>;
}

type Handler = (context: RequestContext) => Reply | Promise<Reply>;

interface Route {
  surface: Surface | "any";
  method: "GET" | "POST";
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

export interface ServerDeps {
  config: InstitutionConfig;
  registry: Registry;
  /** Override for tests; defaults to the configured provider. */
  mailer?: Mailer | null;
  /** Override for tests; the real service uses the global fetch. */
  fetcher?: typeof fetch;
}

const routes: Route[] = [];

function route(surface: Surface | "any", method: "GET" | "POST", path: string, handler: Handler): void {
  const keys: string[] = [];
  const pattern = new RegExp(
    `^${path.replace(/:([A-Za-z]+)/g, (_match, key: string) => {
      keys.push(key);
      return "([^/]+)";
    })}$`,
  );
  routes.push({ surface, method, pattern, keys, handler });
}

function html(status: number, body: string, headers: Record<string, string> = {}): Reply {
  return {
    status,
    body,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...headers },
  };
}

function json(status: number, body: unknown): Reply {
  return {
    status,
    body: JSON.stringify(body),
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  };
}

function redirect(location: string, cookies: string[] = []): Reply {
  return { status: 303, body: "", headers: { location }, cookies };
}

function contextFor(config: InstitutionConfig): UiContext {
  return {
    publicOrigin: config.publicOrigin,
    registrarOrigin: config.registrarOrigin,
    consoleUrl: config.consoleUrl,
    mailDomain: config.mailDomain,
    lmsUrl: config.lmsBaseUrl,
    demo: config.seedDemo,
  };
}

function viewerFor(student: Student | null, staff: string | null): Viewer | null {
  if (student) return { name: `${student.firstName} ${student.lastName}`, role: "student" };
  if (staff) return { name: staff, role: "registrar" };
  return null;
}

function hostnameOf(host: string): string {
  const first = (host.split(",")[0] ?? "").trim();
  if (!first) return "";
  if (first.startsWith("[")) return first.slice(1, first.indexOf("]")).toLowerCase();
  return first.split(":")[0]?.toLowerCase().replace(/\.$/, "") ?? "";
}

function effectiveHost(request: IncomingMessage, config: InstitutionConfig): string {
  if (config.trustProxy) {
    const forwarded = request.headers["x-forwarded-host"];
    const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    if (value) return value.split(",")[0]?.trim() ?? "";
  }
  return request.headers.host ?? "";
}

function sessionFor(
  cookies: Record<string, string>,
  config: InstitutionConfig,
  role: "student" | "registrar",
  now: Date,
): { sub: string; role: "student" | "registrar" } | null {
  const name = role === "student" ? SESSION_COOKIE : STAFF_COOKIE;
  const token = cookies[name];
  if (!token) return null;
  return verifySession(token, config.sessionSecret, role, now);
}

async function readForm(request: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function sameOrigin(request: IncomingMessage, host: string): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function studentRequired(context: RequestContext): Student {
  if (!context.student) throw new Error("student session required");
  return context.student;
}

/**
 * Create or update the provider mailbox. A failure never blocks the portal
 * account: the address stays reserved and a reset retries it.
 */
async function provisionMailbox(
  registry: Registry,
  mailer: Mailer | null,
  student: Student,
  password: string,
): Promise<"active" | "reserved" | "failed"> {
  if (!mailer) return student.mailbox.status === "active" ? "active" : "reserved";
  try {
    await mailer.ensureAccount(student.schoolEmail, password, `${student.firstName} ${student.lastName}`);
    registry.activateMailbox(student.id);
    return "active";
  } catch (error) {
    console.error(
      `atheniq-institution: mailbox provisioning failed for ${student.number}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return "failed";
  }
}

/* ------------------------------------------------------------------ routes */

route("public", "GET", "/", ({ config }) => html(200, home(contextFor(config))));
route("public", "GET", "/academics", ({ config, registry }) =>
  html(200, academics(contextFor(config), registry.courses().all())),
);
route("public", "GET", "/academics/:slug", ({ config, registry, params }) => {
  const program = programBySlug(params.slug ?? "");
  if (!program) return html(404, notFound(contextFor(config), "public"));
  return html(200, programPage(contextFor(config), program, registry.courses().all()));
});
route("public", "GET", "/admissions", ({ config }) => html(200, admissions(contextFor(config))));
route("public", "GET", "/admissions/apply", ({ config, url }) => {
  const program = url.searchParams.get("program") ?? "";
  return html(200, applyForm(contextFor(config), { values: program ? { programSlug: program } : {} }));
});
route("public", "POST", "/admissions/apply", ({ config, registry, body }) => {
  const values = {
    firstName: body.get("firstName") ?? "",
    lastName: body.get("lastName") ?? "",
    email: body.get("email") ?? "",
    country: body.get("country") ?? "",
    programSlug: body.get("programSlug") ?? "",
    termId: body.get("termId") ?? "",
    statement: body.get("statement") ?? "",
    consent: body.get("consent") ?? "",
  };
  const result = registry.createApplication(values);
  if (!result.ok) {
    return html(422, applyForm(contextFor(config), { values, fields: result.fields, error: result.error }));
  }
  return html(201, applicationReceived(contextFor(config), result.value));
});
route("public", "GET", "/about", ({ config }) => html(200, about(contextFor(config))));
route("public", "GET", "/verify", ({ config }) => html(200, verify(contextFor(config), config.credentialVerifyUrl)));
route("public", "GET", "/privacy", ({ config }) => html(200, privacy(contextFor(config))));
route("public", "GET", "/terms", ({ config }) => html(200, terms(contextFor(config))));
route("public", "GET", "/accessibility", ({ config }) => html(200, accessibility(contextFor(config))));
route("public", "GET", "/setup", ({ config }) => html(200, setupHandler(contextFor(config))));
route("public", "GET", "/portal", ({ config }) => html(200, portalSignIn(contextFor(config))));
route("public", "GET", "/portal/signin", () => redirect("/portal"));
route("public", "POST", "/portal/signin", (context) => {
  const email = (context.body.get("email") ?? "").trim();
  const supplied = context.body.get("password") ?? "";
  const key = `${context.ip}:${email.toLowerCase()}`;
  if (!limiter.take(key)) {
    return html(429, portalSignIn(contextFor(context.config), {
      email,
      error: "Too many attempts. Wait ten minutes, then try again.",
    }));
  }
  const result = context.registry.signIn(email, supplied);
  if (!result.ok) {
    return html(401, portalSignIn(contextFor(context.config), { email, error: result.error }));
  }
  limiter.clear(key);
  const student = result.value;
  if (!student) return html(401, portalSignIn(contextFor(context.config), { email, error: "Account unavailable." }));
  const token = signSession(
    { sub: student.id, role: "student", exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS },
    context.config.sessionSecret,
  );
  const cookie = sessionCookie(SESSION_COOKIE, token, {
    secure: context.config.cookieSecure,
    maxAgeSeconds: SESSION_TTL_SECONDS,
  });
  return redirect(student.mustChangePassword ? "/portal/password" : "/portal/dashboard", [cookie]);
});
route("public", "POST", "/portal/signout", ({ config }) =>
  redirect("/portal", [clearCookie(SESSION_COOKIE, config.cookieSecure)]),
);
route("public", "GET", "/portal/dashboard", async (context) => {
  const student = studentRequired(context);
  const transcript = await fetchTranscript(context.config, student.id);
  return html(
    200,
    dashboard(
      contextFor(context.config),
      student,
      context.registry.enrollmentsFor(student.id),
      transcript,
      context.registry.courses().all(),
    ),
  );
});
route("public", "GET", "/portal/register", (context) => {
  const student = studentRequired(context);
  return html(
    200,
    register(
      contextFor(context.config),
      student,
      context.registry.enrollmentsFor(student.id),
      seatCounts(context.registry),
      context.registry.courses().all(),
    ),
  );
});
route("public", "POST", "/portal/register", (context) => {
  const student = studentRequired(context);
  const code = (context.body.get("courseCode") ?? "").trim();
  const result = context.registry.register(student.id, code);
  const enrollments = context.registry.enrollmentsFor(student.id);
  const ui = contextFor(context.config);
  const seats = seatCounts(context.registry);
  const courses = context.registry.courses().all();
  if (!result.ok) {
    return html(409, register(ui, student, enrollments, seats, courses, { error: result.error }));
  }
  return html(200, register(ui, student, enrollments, seats, courses, { notice: `Registered for ${code}. The seat is held for you.` }));
});
route("public", "GET", "/portal/record", async (context) => {
  const student = studentRequired(context);
  const transcript = await fetchTranscript(context.config, student.id);
  return html(
    200,
    record(
      contextFor(context.config),
      student,
      context.registry.enrollmentsFor(student.id),
      transcript,
      context.registry.courses().all(),
    ),
  );
});
route("public", "GET", "/portal/account", (context) => {
  const student = studentRequired(context);
  return html(200, account(contextFor(context.config), student));
});
route("public", "GET", "/portal/password", (context) => {
  const student = studentRequired(context);
  return html(200, password(contextFor(context.config), student, { forced: student.mustChangePassword }));
});
route("public", "POST", "/portal/password", async (context) => {
  const student = studentRequired(context);
  const current = context.body.get("current") ?? "";
  const next = context.body.get("next") ?? "";
  const confirm = context.body.get("confirm") ?? "";
  const ui = contextFor(context.config);
  if (next !== confirm) {
    return html(422, password(ui, student, { forced: student.mustChangePassword, error: "The two new passwords do not match." }));
  }
  const result = context.registry.changePassword(student.id, current, next);
  if (!result.ok) {
    return html(422, password(ui, student, { forced: student.mustChangePassword, error: result.error }));
  }
  await provisionMailbox(context.registry, context.mailer, student, next);
  return redirect("/portal/dashboard");
});

route("registrar", "GET", "/signin", ({ config }) => html(200, registrarSignIn(contextFor(config))));
route("registrar", "GET", "/", ({ config, registry }) => {
  const ui = contextFor(config);
  return html(
    200,
    registrarDashboard(
      ui,
      registry.summary(),
      registry.applications(),
      registry.students(),
      registry.courses().summary(),
    ),
  );
});
route("registrar", "POST", "/signin", (context) => {
  const email = (context.body.get("email") ?? "").trim().toLowerCase();
  const supplied = context.body.get("password") ?? "";
  const key = `${context.ip}:staff:${email}`;
  const ui = contextFor(context.config);
  if (!limiter.take(key)) {
    return html(429, registrarSignIn(ui, { email, error: "Too many attempts. Wait ten minutes, then try again." }));
  }
  const config = context.config;
  const emailOk = safeEqual(email, config.registrarEmail);
  const passwordOk = config.registrarPassword.startsWith("scrypt$")
    ? verifyPassword(supplied, config.registrarPassword)
    : safeEqual(supplied, config.registrarPassword);
  if (!emailOk || !passwordOk) {
    return html(401, registrarSignIn(ui, { email, error: "That staff email and password do not match." }));
  }
  limiter.clear(key);
  const token = signSession(
    { sub: config.registrarEmail, role: "registrar", exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS },
    config.sessionSecret,
  );
  return redirect("/", [
    sessionCookie(STAFF_COOKIE, token, { secure: config.cookieSecure, maxAgeSeconds: SESSION_TTL_SECONDS }),
  ]);
});
route("registrar", "POST", "/signout", ({ config }) =>
  redirect("/signin", [clearCookie(STAFF_COOKIE, config.cookieSecure)]),
);
route("registrar", "GET", "/applications", ({ config, registry }) => {
  return html(200, applications(contextFor(config), registry.applications()));
});
route("registrar", "GET", "/applications/:id", ({ config, registry, params, url }) => {
  const application = registry.application(params.id ?? "");
  if (!application) return html(404, notFound(contextFor(config), "registrar"));
  return html(
    200,
    applicationDetail(contextFor(config), application, {
      error: url.searchParams.get("error") ?? undefined,
      notice: url.searchParams.get("notice") ?? undefined,
    }),
  );
});
route("registrar", "POST", "/applications/:id/decision", async ({ config, registry, mailer, params, body }) => {
  const applicationId = params.id ?? "";
  const application = registry.application(applicationId);
  const ui = contextFor(config);
  if (!application) return html(404, notFound(ui, "registrar"));
  const decision = body.get("decision") === "deny" ? "deny" : "admit";
  const result = registry.decide(applicationId, decision, body.get("note") ?? "");
  if (!result.ok) {
    return html(409, applicationDetail(ui, application, { error: result.error }));
  }
  const fresh = registry.application(applicationId) ?? application;
  if (decision === "deny") {
    return html(200, applicationDetail(ui, fresh, { notice: "Application declined. No account was created." }));
  }
  const student = result.value.student;
  const tempPassword = result.value.tempPassword;
  const mailbox = student && tempPassword ? await provisionMailbox(registry, mailer, student, tempPassword) : null;
  const mailboxNote = !student
    ? ""
    : mailbox === "active"
      ? mailer && !mailer.passwordManaged
        ? " The mailbox is active; mail sign-in uses the mail server's single sign-on rather than the temporary password."
        : ` The mailbox is active at ${mailer?.provider ?? "the provider"}.`
      : mailer
        ? " The mailbox is still reserved: the provider did not accept the account. It is listed under Roster with a retry once the Stalwart settings are fixed."
        : " The address is reserved because mail delivery is not configured; it is listed under Roster with a retry once a provider is set.";
  return html(
    200,
    applicationDetail(ui, fresh, {
      notice: `Admitted. The student account and address were created in one write.${mailboxNote}`,
      ...(student && tempPassword
        ? {
            credentials: {
              studentId: student.id,
              number: student.number,
              email: student.schoolEmail,
              tempPassword,
            },
          }
        : {}),
    }),
  );
});
route("registrar", "GET", "/students", ({ config, registry, mailer }) => {
  return html(200, students(contextFor(config), registry.students(), { configured: Boolean(mailer) }));
});
route("registrar", "GET", "/students/:id", ({ config, registry, mailer, params, url }) => {
  const student = registry.student(params.id ?? "");
  if (!student) return html(404, notFound(contextFor(config), "registrar"));
  return html(
    200,
    studentDetail(
      contextFor(config),
      student,
      registry.enrollmentsFor(student.id),
      registry.courses().all(),
      {
        error: url.searchParams.get("error") ?? undefined,
        notice: url.searchParams.get("notice") ?? undefined,
        mailConfigured: Boolean(mailer),
      },
    ),
  );
});
route("registrar", "POST", "/students/:id/reset", async ({ config, registry, mailer, params }) => {
  const student = registry.student(params.id ?? "");
  const ui = contextFor(config);
  if (!student) return html(404, notFound(ui, "registrar"));
  const result = registry.resetAccess(student.id);
  if (!result.ok) {
    return html(
      409,
      studentDetail(ui, student, registry.enrollmentsFor(student.id), registry.courses().all(), {
        error: result.error,
        mailConfigured: Boolean(mailer),
      }),
    );
  }
  const mailbox = await provisionMailbox(registry, mailer, student, result.value.tempPassword);
  const fresh = registry.student(student.id) ?? student;
  const notice = !mailer
    ? "Access reset. Hand the temporary password over securely."
    : mailbox === "active"
      ? mailer.passwordManaged
        ? "Access reset. The mailbox password was updated. Hand the temporary password over securely."
        : "Access reset. The portal password changed; mail sign-in is unchanged because the mail server uses single sign-on."
      : "Access reset. The portal password changed, but the mailbox could not be updated. Fix the Stalwart settings and reset again.";
  return html(
    200,
    studentDetail(ui, fresh, registry.enrollmentsFor(fresh.id), registry.courses().all(), {
      notice,
      tempPassword: result.value.tempPassword,
      mailConfigured: Boolean(mailer),
    }),
  );
});

/**
 * Retry a mailbox that admission could only reserve. The provider needs a plain
 * password to create the account, and the registry keeps only a hash, so the
 * retry issues a fresh temporary password and hands it back once. Refuses when
 * no provider is configured: there would be nothing to reach.
 */
route("registrar", "POST", "/students/:id/mailbox", async ({ config, registry, mailer, params }) => {
  const student = registry.student(params.id ?? "");
  const ui = contextFor(config);
  if (!student) return html(404, notFound(ui, "registrar"));
  const render = (state: { error?: string; notice?: string; tempPassword?: string }) => {
    const fresh = registry.student(student.id) ?? student;
    return html(
      200,
      studentDetail(ui, fresh, registry.enrollmentsFor(fresh.id), registry.courses().all(), {
        ...state,
        mailConfigured: Boolean(mailer),
      }),
    );
  };
  if (student.mailbox.status !== "reserved") {
    return render({ notice: "That mailbox is already active — there is nothing to retry." });
  }
  if (!mailer) {
    return render({
      error: `${student.schoolEmail} is still reserved: mail delivery is not configured (MAIL_PROVIDER=local), so there is no provider to retry against.`,
    });
  }
  const reset = registry.resetAccess(student.id);
  if (!reset.ok) return render({ error: reset.error });
  const mailbox = await provisionMailbox(registry, mailer, student, reset.value.tempPassword);
  if (mailbox === "active") {
    return render({
      notice: `Mailbox activated at ${mailer.provider} for ${student.schoolEmail}. A new temporary password was issued with it.`,
      tempPassword: reset.value.tempPassword,
    });
  }
  return render({
    error: `${student.schoolEmail} is still reserved: the provider did not accept the account. The portal password was reset anyway, so hand over the new temporary password below, fix the mail settings, then retry.`,
    tempPassword: reset.value.tempPassword,
  });
});

/* ---------------------------------------------------------------- courses */

function parsedStatus(value: string | null): "draft" | "published" | "archived" {
  return value === "published" || value === "archived" ? value : "draft";
}

function splitLines(value: string | null): string[] {
  return (value ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

interface ParsedCourse {
  values: Record<string, string>;
  input: CourseInput | null;
  error?: string;
  fields?: Record<string, string>;
}

/** Turn a catalog form post into the catalog's input shape, or a field error. */
function parseCourseBody(body: URLSearchParams, catalog: Catalog): ParsedCourse {
  const raw = (name: string): string => body.get(name) ?? "";
  const values: Record<string, string> = {
    code: raw("code").trim().toUpperCase() || suggestCode(catalog.all(), "AI"),
    title: raw("title"),
    termId: raw("termId"),
    credits: raw("credits"),
    instructor: raw("instructor"),
    format: raw("format"),
    seats: raw("seats"),
    weeks: raw("weeks"),
    summary: raw("summary"),
    description: raw("description"),
    outcomes: raw("outcomes"),
    prerequisites: raw("prerequisites"),
    audience: raw("audience"),
    status: parsedStatus(body.get("status")),
    modules: raw("modules"),
    grading: raw("grading"),
  };

  const modulesRaw = (values.modules ?? "").trim();
  let modules: unknown = [];
  if (modulesRaw) {
    try {
      modules = JSON.parse(modulesRaw);
    } catch {
      return {
        values,
        input: null,
        error: "The modules field is not valid JSON.",
        fields: { modules: "Not valid JSON." },
      };
    }
  }

  const gradingRaw = (values.grading ?? "").trim();
  let grading: unknown = [];
  if (gradingRaw) {
    try {
      grading = JSON.parse(gradingRaw);
    } catch {
      return {
        values,
        input: null,
        error: "The grading field is not valid JSON.",
        fields: { grading: "Not valid JSON." },
      };
    }
  }

  const input: CourseInput = {
    code: values.code ?? "",
    title: values.title ?? "",
    termId: values.termId ?? "",
    credits: Number(values.credits),
    instructor: values.instructor ?? "",
    format: values.format ?? "",
    seats: Number(values.seats),
    weeks: Number(values.weeks),
    summary: values.summary ?? "",
    description: values.description ?? "",
    outcomes: splitLines(values.outcomes ?? ""),
    prerequisites: splitLines(values.prerequisites ?? ""),
    audience: values.audience ?? "",
    modules: coerceModules(modules),
    grading: coerceGrading(grading),
    programs: body.getAll("programs"),
    status: parsedStatus(values.status ?? null),
  };
  return { values, input };
}

route("registrar", "GET", "/courses", ({ config, registry, url }) => {
  const ui = contextFor(config);
  const notice = url.searchParams.get("notice");
  const error = url.searchParams.get("error");
  return html(
    200,
    coursesIndex(ui, registry.courses().all(), registry.courses().syncState(), {
      ...(notice ? { notice } : {}),
      ...(error ? { error } : {}),
    }),
  );
});
route("registrar", "POST", "/courses/sync", async ({ config, registry, fetcher }) => {
  const catalog = registry.courses();
  const result = await fetchLmsCatalog(config, fetcher);
  if (!result.ok) {
    catalog.recordSyncError(result.error ?? "The LMS sync failed.");
    return redirect(`/courses?error=${encodeURIComponent(result.error ?? "The LMS sync failed.")}`);
  }
  const known = new Set(catalog.all().map((course) => course.code));
  catalog.recordSync(
    {
      at: new Date().toISOString(),
      keys: result.courses.map((course) => course.key),
      codes: result.courses.map((course) => course.code),
      external: result.courses.filter((course) => !known.has(course.code)),
    },
    null,
  );
  return redirect(
    `/courses?notice=${encodeURIComponent(`Checked ${config.lmsBaseUrl}: ${result.courses.length} courses served by the LMS.`)}`,
  );
});

route("registrar", "GET", "/courses/new", ({ config, registry }) => {
  const catalog = registry.courses();
  return html(
    200,
    courseForm(contextFor(config), catalog.all(), {
      mode: "new",
      values: {
        code: suggestCode(catalog.all(), "AI"),
        termId: "2027A",
        credits: "15",
        seats: "30",
        weeks: "12",
        format: "Studio · 12 weeks",
        status: "draft",
      },
      sync: catalog.syncState(),
    }),
  );
});
route("registrar", "POST", "/courses", ({ config, registry, body }) => {
  const catalog = registry.courses();
  const ui = contextFor(config);
  const parsed = parseCourseBody(body, catalog);
  if (!parsed.input) {
    return html(
      422,
      courseForm(ui, catalog.all(), {
        mode: "new",
        values: parsed.values,
        ...(parsed.fields ? { fields: parsed.fields } : {}),
        error: parsed.error ?? "Please correct the highlighted fields.",
        sync: catalog.syncState(),
      }),
    );
  }
  const result = catalog.create(parsed.input);
  if (!result.ok) {
    return html(
      422,
      courseForm(ui, catalog.all(), {
        mode: "new",
        values: parsed.values,
        ...(result.fields ? { fields: result.fields } : {}),
        error: result.error,
        sync: catalog.syncState(),
      }),
    );
  }
  return redirect(
    `/courses/${result.value.code}?notice=${encodeURIComponent(`${result.value.code} was added to the catalog as a ${result.value.status}.`)}`,
  );
});

route("registrar", "GET", "/courses/generate", ({ config, registry }) => {
  const catalog = registry.courses();
  return html(
    200,
    generateForm(contextFor(config), {
      termId: "2027A",
      code: suggestCode(catalog.all(), "AI"),
    }),
  );
});
route("registrar", "POST", "/courses/generate", async ({ config, registry, body, fetcher }) => {
  const ui = contextFor(config);
  const prompt = (body.get("prompt") ?? "").trim();
  const termId = body.get("termId") ?? "2027A";
  const code = (body.get("code") ?? "").trim().toUpperCase();
  if (prompt.length < 12) {
    return html(
      422,
      generateForm(ui, {
        error: "Describe the course in at least a sentence — the audience and the subject are enough.",
        prompt,
        termId,
      }),
    );
  }
  const result = await generateDraft(config, prompt, fetcher);
  return html(
    200,
    generatePreview(ui, result, {
      code: code || suggestCode(registry.courses().all(), "AI"),
      termId,
      instructor: "",
      format: "",
      seats: "30",
      weeks: String(result.draft.weeks),
      status: "draft",
    }),
  );
});
route("registrar", "POST", "/courses/generate/accept", ({ config, registry, body }) => {
  const catalog = registry.courses();
  const ui = contextFor(config);
  const note = body.get("note") ?? "This draft was generated in the AI studio.";
  const engine = body.get("engine") === "rules" ? "rules" : "gateway";
  let draft: ReturnType<typeof coerceDraft> = null;
  try {
    draft = coerceDraft(JSON.parse(body.get("draft") ?? "null") as unknown);
  } catch {
    draft = null;
  }
  if (!draft) {
    return html(
      422,
      generateForm(ui, { error: "The draft could not be read. Generate it again and accept the new preview." }),
    );
  }

  const termId = body.get("termId") ?? "2027A";
  const weeks = Number(body.get("weeks"));
  const seats = Number(body.get("seats"));
  const input: CourseInput = {
    code: (body.get("code") ?? "").trim().toUpperCase() || suggestCode(catalog.all(), "AI"),
    title: draft.title,
    termId,
    credits: draft.credits,
    instructor: (body.get("instructor") ?? "").trim() || draft.instructor,
    format: (body.get("format") ?? "").trim() || draft.format,
    seats: Number.isFinite(seats) ? seats : 30,
    weeks: Number.isFinite(weeks) ? weeks : draft.weeks,
    summary: draft.summary,
    description: draft.description,
    outcomes: draft.outcomes,
    prerequisites: draft.prerequisites,
    audience: draft.audience,
    modules: draft.modules,
    grading: draft.grading,
    programs: [],
    status: body.get("status") === "published" ? "published" : "draft",
    source: "ai",
  };
  const result = catalog.create(input);
  if (!result.ok) {
    return html(
      422,
      generatePreview(
        ui,
        { draft, engine, note },
        {
          code: input.code,
          termId,
          instructor: input.instructor,
          format: input.format,
          seats: String(input.seats),
          weeks: String(input.weeks),
          status: input.status ?? "draft",
        },
        { error: result.error },
      ),
    );
  }
  return redirect(
    `/courses/${result.value.code}?notice=${encodeURIComponent(`Accepted the AI draft as ${result.value.code}. Review it, then publish when it is right.`)}`,
  );
});

route("registrar", "POST", "/courses/import", ({ config, registry, body }) => {
  const catalog = registry.courses();
  const ui = contextFor(config);
  const code = (body.get("code") ?? "").trim().toUpperCase();
  const title = (body.get("title") ?? "").trim();
  const key = (body.get("key") ?? "").trim();
  if (!code || !title) {
    return html(422, coursesIndex(ui, catalog.all(), catalog.syncState(), {
      error: "The import needs a course code and a title from the LMS.",
    }));
  }
  const termFromKey = /^course-v1:[^+]+\+[^+]+\+(.+)$/.exec(key)?.[1] ?? "";
  const termId = /^\d{4}A$|^\d{4}B$|^\d{4}C$/.test(termFromKey) ? termFromKey : "2027A";
  const result = catalog.create({
    code,
    title,
    termId,
    credits: 15,
    instructor: "Faculty of the Institute",
    format: "Imported from the LMS",
    seats: 30,
    weeks: 12,
    summary: `${title} — imported from the LMS catalog. Edit the summary, credits and curriculum before publishing it here.`,
    status: "draft",
  });
  if (!result.ok) {
    return html(422, coursesIndex(ui, catalog.all(), catalog.syncState(), { error: result.error }));
  }
  return redirect(`/courses/${result.value.code}?notice=${encodeURIComponent(`Imported ${result.value.code} as a draft. It is a local record until you publish it.`)}`);
});

route("registrar", "GET", "/courses/:code", ({ config, registry, params, url }) => {
  const catalog = registry.courses();
  const course = catalog.byCode(params.code ?? "");
  const ui = contextFor(config);
  if (!course) return html(404, notFound(ui, "registrar"));
  const notice = url.searchParams.get("notice");
  const error = url.searchParams.get("error");
  return html(
    200,
    courseForm(ui, catalog.all(), {
      mode: "edit",
      values: courseValues(course),
      ...(notice ? { notices: [notice] } : {}),
      ...(error ? { error } : {}),
      sync: catalog.syncState(),
    }),
  );
});
route("registrar", "POST", "/courses/:code", ({ config, registry, params, body }) => {
  const catalog = registry.courses();
  const ui = contextFor(config);
  const code = (params.code ?? "").toUpperCase();
  const existing = catalog.byCode(code);
  if (!existing) return html(404, notFound(ui, "registrar"));
  const parsed = parseCourseBody(body, catalog);
  parsed.values.code = code;
  if (!parsed.input) {
    return html(
      422,
      courseForm(ui, catalog.all(), {
        mode: "edit",
        values: parsed.values,
        ...(parsed.fields ? { fields: parsed.fields } : {}),
        error: parsed.error ?? "Please correct the highlighted fields.",
        sync: catalog.syncState(),
      }),
    );
  }
  const result = catalog.update(code, parsed.input);
  if (!result.ok) {
    return html(
      422,
      courseForm(ui, catalog.all(), {
        mode: "edit",
        values: parsed.values,
        ...(result.fields ? { fields: result.fields } : {}),
        error: result.error,
        sync: catalog.syncState(),
      }),
    );
  }
  return redirect(`/courses/${code}?notice=${encodeURIComponent(`${code} saved.`)}`);
});
route("registrar", "POST", "/courses/:code/delete", ({ config, registry, params }) => {
  const catalog = registry.courses();
  const code = (params.code ?? "").toUpperCase();
  if (!catalog.byCode(code)) return html(404, notFound(contextFor(config), "registrar"));
  const enrolled = registry.enrollmentsForCourse(code);
  if (enrolled > 0) {
    return redirect(
      `/courses/${code}?error=${encodeURIComponent(
        `${code} has ${enrolled} enrollment${enrolled === 1 ? "" : "s"} on record. Archive it instead of removing it.`,
      )}`,
    );
  }
  const result = catalog.remove(code);
  if (!result.ok) return redirect(`/courses/${code}?error=${encodeURIComponent(result.error)}`);
  return redirect(`/courses?notice=${encodeURIComponent(`Removed ${code} from the catalog.`)}`);
});

/** The classroom cookie the OpenMAIC host method reads. */
function classroomCookie(token: string, config: InstitutionConfig): string {
  const parts = [
    `atheniq_classroom=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.max(300, 900)}`,
  ];
  if (config.classroomCookieDomain) parts.push(`Domain=${config.classroomCookieDomain}`);
  if (config.cookieSecure) parts.push("Secure");
  return parts.join("; ");
}

route("registrar", "GET", "/courses/:code/classroom", ({ config, registry, params }) => {
  const course = registry.courses().byCode(params.code ?? "");
  const ui = contextFor(config);
  if (!course) return html(404, notFound(ui, "registrar"));
  const base = config.openmaicPublicUrl;
  const stage = course.classroom?.stageId ?? null;
  // A classroom exists as soon as the bridge has created it, but OpenMAIC names
  // the stage only once the generator has written one. Until then embed the
  // classroom host: it is the same signed-in owner's library, not an empty page.
  const url = base && course.classroom ? (stage ? `${base}/classroom/${encodeURIComponent(stage)}` : `${base}/`) : null;
  return html(
    200,
    classroomView(ui, course, {
      configured: Boolean(base && config.bridgeUrl && config.bridgeToken),
      url,
    }),
  );
});
route("registrar", "POST", "/courses/:code/classroom", async ({ config, registry, params, fetcher }) => {
  const catalog = registry.courses();
  const ui = contextFor(config);
  let course = catalog.byCode(params.code ?? "");
  if (!course) return html(404, notFound(ui, "registrar"));
  const configured = Boolean(config.openmaicPublicUrl && config.bridgeUrl && config.bridgeToken);

  if (!course.classroom?.classroomId) {
    const started = await startClassroom(config, course, fetcher);
    if (!started.ok || !started.classroom) {
      return html(502, classroomView(ui, course, { configured, error: started.note }));
    }
    const saved = catalog.setClassroom(course.code, started.classroom);
    if (saved.ok) course = saved.value;
  }

  const signed = await signInToClassroom(config, course, fetcher);
  if (!signed.ok || !signed.token) {
    return html(502, classroomView(ui, course, { configured, error: signed.note }));
  }
  // A later sign-in can name the stage the first response did not have yet.
  const stage = stageFrom(signed.url);
  if (stage && course.classroom && stage !== course.classroom.stageId) {
    const saved = catalog.setClassroom(course.code, { ...course.classroom, stageId: stage });
    if (saved.ok) course = saved.value;
  }
  return redirect(`/courses/${course.code}/classroom`, [classroomCookie(signed.token, config)]);
});

const limiter = new AttemptLimiter();

function seatCounts(registry: Registry): Record<string, number> {
  return Object.fromEntries(
    registry.courses().all().map((course) => [course.code, registry.seatsTaken(course.code)]),
  );
}

/* ---------------------------------------------------------------- dispatch */

function assetReply(path: string, method: string): Reply | null {
  if (!path.startsWith("/assets/")) return null;
  const name = path.slice("/assets/".length);
  const asset = ASSETS[name];
  if (!asset) return null;
  return {
    status: 200,
    body: method === "HEAD" ? "" : asset.body.toString("utf8"),
    headers: {
      "content-type": asset.type,
      "cache-control": "public, max-age=300",
      "x-content-type-options": "nosniff",
    },
  };
}

export function createInstitutionServer(deps: ServerDeps) {
  const { config, registry } = deps;
  const fetcher = deps.fetcher ?? fetch;
  const mailer = deps.mailer === undefined ? createMailer(config) : deps.mailer;
  const registrarHostname = hostnameOf(new URL(config.registrarOrigin).host);

  return createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      console.error(`[institution] ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      if (!response.headersSent) {
        response.statusCode = 500;
        response.setHeader("content-type", "text/html; charset=utf-8");
        response.end("<!doctype html><meta charset=utf-8><title>Error</title><p>The institution service could not render this page.</p>");
      } else {
        response.end();
      }
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const started = Date.now();
    const requestId = request.headers["x-request-id"]?.toString().slice(0, 64) || randomUUID();
    response.setHeader("x-request-id", requestId);
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "strict-origin-when-cross-origin");
    response.setHeader("permissions-policy", "geolocation=(), camera=(), microphone=()");
    // The classroom is the only embedded origin, and only when it is configured.
    const frameSource = config.openmaicPublicUrl ? `frame-src 'self' ${config.openmaicPublicUrl}; ` : "frame-src 'self'; ";
    response.setHeader(
      "content-security-policy",
      `default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; ${frameSource}form-action 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'`,
    );
    response.setHeader("x-frame-options", "DENY");
    if (config.cookieSecure) {
      response.setHeader("strict-transport-security", "max-age=31536000; includeSubDomains");
    }

    const method = request.method === "HEAD" ? "HEAD" : request.method === "POST" ? "POST" : "GET";
    const url = new URL(request.url ?? "/", config.publicOrigin);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const host = effectiveHost(request, config);
    const hostname = hostnameOf(host);
    const surface: Surface = hostname === registrarHostname || hostname.startsWith("registrar.") ? "registrar" : "public";

    if (path.startsWith("/assets/")) {
      const asset = assetReply(path, method);
      if (asset) return send(response, asset, method);
    }

    if (path === "/health") return send(response, json(200, { ok: true, service: SERVICE }), method);
    if (path === "/robots.txt") {
      const body = surface === "registrar" ? "User-agent: *\nDisallow: /\n" : "User-agent: *\nAllow: /\nDisallow: /portal\n";
      return send(
        response,
        { status: 200, body, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=300" } },
        method,
      );
    }

    const ui = contextFor(config);

    if (method === "POST" && !sameOrigin(request, host)) {
      return send(response, html(403, errorPage(ui, surface, null, "This form was submitted from another origin.")), method);
    }

    const now = new Date();
    const cookies = parseCookies(request.headers.cookie);
    const studentSession = sessionFor(cookies, config, "student", now);
    const staffSession = sessionFor(cookies, config, "registrar", now);
    const student = studentSession ? registry.student(studentSession.sub) ?? null : null;
    const staff = staffSession && safeEqual(staffSession.sub, config.registrarEmail) ? staffSession.sub : null;

    const viewer = viewerFor(student, staff);

    // `Host` decides the surface, and each surface has exactly one entrance.
    if (surface === "registrar") {
      if (!staff && path !== "/signin" && path !== "/signout") {
        if (path === "/" && method === "GET") return send(response, html(200, registrarSignIn(ui)), method);
        return send(response, redirect("/signin"), method);
      }
    } else {
      if (path === "/registrar" || path.startsWith("/registrar/")) {
        const rest = path.slice("/registrar".length) || "/";
        return send(response, redirect(`${config.registrarOrigin}${rest}`), method);
      }
      if (!student && path.startsWith("/portal") && path !== "/portal/signin" && path !== "/portal/signout") {
        if (path === "/portal" && method === "GET") return send(response, html(200, portalSignIn(ui)), method);
        return send(response, redirect("/portal"), method);
      }
      if (student && path === "/portal" && method === "GET") {
        return send(response, redirect("/portal/dashboard"), method);
      }
      if (student && student.mustChangePassword && path !== "/portal/password" && path !== "/portal/signout") {
        return send(response, redirect("/portal/password"), method);
      }
    }

    const body = method === "POST" ? await readForm(request) : new URLSearchParams();
    const context: RequestContext = {
      config,
      registry,
      url,
      body,
      ip: ipOf(request, config),
      student,
      mailer,
      fetcher,
      params: {},
    };

    let pathMatched = false;
    for (const candidate of routes) {
      if (candidate.surface !== "any" && candidate.surface !== surface) continue;
      const match = candidate.pattern.exec(path);
      if (!match) continue;
      pathMatched = true;
      if (candidate.method !== method && !(method === "HEAD" && candidate.method === "GET")) continue;

      const params: Record<string, string> = {};
      candidate.keys.forEach((key, index) => {
        params[key] = decodeURIComponent(match[index + 1] ?? "");
      });
      const reply = await candidate.handler({ ...context, params });
      log(`[institution] ${method} ${path} ${reply.status} ${Date.now() - started}ms ${requestId}`);
      return send(response, reply, method);
    }

    if (pathMatched) {
      return send(response, html(405, errorPage(ui, surface, viewer, "That method is not allowed on this page.")), method);
    }
    return send(response, html(404, notFound(ui, surface, viewer)), method);
  }
}

function ipOf(request: IncomingMessage, config: InstitutionConfig): string {
  if (config.trustProxy) {
    const forwarded = request.headers["x-forwarded-for"];
    const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    if (value) return value.split(",")[0]?.trim() ?? "unknown";
  }
  return request.socket.remoteAddress ?? "unknown";
}

function errorPage(ctx: UiContext, surface: Surface, viewer: Viewer | null, message: string): string {
  const body = `<section class="section"><div class="shell">
    <p class="eyebrow">Error</p>
    <h1 class="display-sm">Something went wrong.</h1>
    <p class="muted-copy">${esc(message)}</p>
    <div class="actions"><a class="button" href="/">Back</a></div>
  </div></section>`;
  return layout({ title: "Error", surface, viewer, ctx, body });
}

function send(response: ServerResponse, reply: Reply, method: string): void {
  response.statusCode = reply.status;
  for (const [name, value] of Object.entries(reply.headers ?? {})) response.setHeader(name, value);
  for (const cookie of reply.cookies ?? []) response.appendHeader("set-cookie", cookie);
  if (method === "HEAD") {
    response.end();
    return;
  }
  response.end(reply.body);
}

function log(line: string): void {
  if (process.env.NODE_ENV === "test") return;
  console.log(line);
}

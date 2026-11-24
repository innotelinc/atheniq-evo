/**
 * The student portal: the place a learner signs in, registers for classes,
 * reads their record and manages the account the Institute issued them.
 *
 * It is deliberately separate from the public site by session, not by path, and
 * it never shows another student's data: every query is scoped to the signed-in
 * student id from the session cookie.
 */

import type { CatalogCourse } from "../catalog.ts";
import { TERMS, programBySlug, termById } from "../content.ts";
import type { Enrollment, Student } from "../store.ts";
import type { TranscriptResult } from "../bridge.ts";
import {
  courseOf,
  dateLabel,
  emptyState,
  esc,
  field,
  layout,
  metric,
  notice,
  pageHead,
  statusBadge,
  type UiContext,
} from "../ui.ts";

function viewerFor(student: Student) {
  return { name: `${student.firstName} ${student.lastName}`, role: "student" as const };
}

function programLabel(student: Student): string {
  const program = programBySlug(student.programSlug);
  return program ? `${program.credential} ${program.name}` : student.programSlug;
}

export function signIn(ctx: UiContext, state: { error?: string; email?: string } = {}): string {
  const body = `
  <div class="auth">
    <aside class="auth__aside">
      <div>
        <p class="eyebrow">Student portal</p>
        <h2>Your record, your registration, your credentials.</h2>
        <p>The account the Institute issued at enrollment is the only account you need. It opens your courses, your AI classrooms and your academic record.</p>
      </div>
      <ul class="auth__list">
        <li>Register for term courses and see seat availability.</li>
        <li>Open the AI classroom attached to each course.</li>
        <li>Read your record: registrations, completions and awards.</li>
        <li>Manage your <strong>@${esc(ctx.mailDomain)}</strong> address.</li>
      </ul>
    </aside>
    <div class="auth__main">
      <div class="auth__form">
        <p class="eyebrow">Sign in</p>
        <h1>Student portal</h1>
        <p>Use the <strong>@${esc(ctx.mailDomain)}</strong> address issued to you, not your personal email.</p>
        ${state.error ? notice("error", state.error) : ""}
        <form method="post" action="/portal/signin">
          ${field({ label: "AthenIQ email", name: "email", type: "email", value: state.email, autocomplete: "username", inputmode: "email", required: true, placeholder: `first.last@${ctx.mailDomain}` })}
          ${field({ label: "Password", name: "password", type: "password", autocomplete: "current-password", required: true })}
          <button class="button" type="submit">Sign in</button>
        </form>
        ${
          ctx.demo
            ? `<div class="alert alert--info mt-6"><p><strong>Preview account.</strong><br>nadia.rahman@${esc(ctx.mailDomain)} · atheniq-demo</p></div>`
            : `<p class="form-note">Lost your password? The registrar can issue a new temporary password. Write to <a href="mailto:registrar@${esc(ctx.mailDomain)}">registrar@${esc(ctx.mailDomain)}</a>.</p>`
        }
        <p class="form-note">Not a student yet? <a href="/admissions/apply">Apply to the Institute</a>.</p>
      </div>
    </div>
  </div>`;

  return layout({ title: "Student sign-in", surface: "portal", viewer: null, ctx, body, description: "AthenIQ Institute student portal." });
}

export function dashboard(
  ctx: UiContext,
  student: Student,
  enrollments: Enrollment[],
  transcript: TranscriptResult,
  courses: CatalogCourse[],
): string {
  const current = enrollments.filter((item) => item.status === "registered");
  const completed = enrollments.filter((item) => item.status === "completed");
  const program = programBySlug(student.programSlug);
  const term = termById(student.termId);
  const credits = completed.reduce((total, item) => total + (courseOf(courses, item.courseCode)?.credits ?? 0), 0);

  const body = `
  ${pageHead({
    eyebrow: `${student.number} · ${term?.name ?? student.termId}`,
    title: `Welcome back, ${student.firstName}.`,
    lede: `${programLabel(student)}. ${program ? program.cohort : ""}`,
    facts: [
      { label: "Student number", value: student.number },
      { label: "AthenIQ email", value: student.schoolEmail },
      { label: "Program", value: programLabel(student) },
      { label: "Status", value: student.status },
    ],
  })}

  <section class="section section--tight">
    <div class="shell">
      ${
        student.mustChangePassword
          ? notice("info", "You are still using the temporary password issued by the registrar. Set your own password from Account.")
          : ""
      }
      <div class="metrics">
        ${metric(String(credits), "credits completed")}
        ${metric(String(current.length), "courses registered")}
        ${metric(String(completed.length), "courses completed")}
        ${metric(student.mailbox.status === "reserved" ? "Reserved" : student.mailbox.status, "mailbox")}
      </div>
    </div>
  </section>

  <section class="section section--tight">
    <div class="shell">
      <div class="section-head">
        <div>
          <p class="eyebrow">This term</p>
          <h2>Your registrations.</h2>
        </div>
        <div class="section-head__aside">
          <p>Registration is open for ${esc(TERMS.filter((item) => item.registration === "open").map((item) => item.name).join(" and "))}. Seats are held when you register.</p>
          <a class="textlink textlink--arrow" href="/portal/register">Register for classes <span aria-hidden="true">→</span></a>
        </div>
      </div>
      ${
        current.length > 0
          ? `<div class="table-wrap">
              <table class="table">
                <thead><tr><th>Course</th><th>Term</th><th>Instructor</th><th class="num">Credits</th><th>Status</th></tr></thead>
                <tbody>
                  ${current
                    .map((enrollment) => {
                      const course = courseOf(courses, enrollment.courseCode);
                      const enrollmentTerm = termById(enrollment.termId);
                      return `<tr>
                        <td><span class="strong">${esc(course?.title ?? enrollment.courseCode)}</span><span class="table__sub">${esc(course?.code ?? "")} · ${esc(course?.format ?? "")}</span></td>
                        <td>${esc(enrollmentTerm?.name ?? enrollment.termId)}</td>
                        <td>${esc(course?.instructor ?? "—")}</td>
                        <td class="num">${course?.credits ?? 0}</td>
                        <td>${statusBadge(enrollment.status)}</td>
                      </tr>`;
                    })
                    .join("")}
                </tbody>
              </table>
            </div>`
          : emptyState(
              "No registrations yet",
              "Registration for Fall 2027 is open. Choose from the catalog; a seat is held as soon as you register.",
              { href: "/portal/register", label: "Browse the catalog" },
            )
      }
    </div>
  </section>

  <section class="section section--tight">
    <div class="shell split">
      <div>
        <div class="section-head">
          <div>
            <p class="eyebrow">AI classrooms</p>
            <h2>Practice that knows the course.</h2>
          </div>
          <div class="section-head__aside">
            <p>Each course has a classroom that can explain, question and set practice against its own material. Completions are reported to your record.</p>
          </div>
        </div>
        ${
          transcript.entries.length > 0
            ? `<div class="table-wrap">
                <table class="table">
                  <thead><tr><th>Classroom</th><th>Completed</th><th>Grade</th><th>Credential</th></tr></thead>
                  <tbody>
                    ${transcript.entries
                      .map(
                        (entry) => `<tr>
                          <td><span class="strong">${esc(entry.courseKey ?? "Classroom")}</span><span class="table__sub">${esc(entry.completionId ?? "")}</span></td>
                          <td>${esc(dateLabel(entry.completedAt))}</td>
                          <td class="num">${entry.grade?.percent !== undefined ? `${entry.grade.percent}%` : "—"}</td>
                          <td>${entry.credential?.verifyId ? `<span class="code">${esc(entry.credential.verifyId)}</span>` : "—"}</td>
                        </tr>`,
                      )
                      .join("")}
                  </tbody>
                </table>
              </div>`
            : emptyState(
                "No classroom activity yet",
                transcript.ok
                  ? "Your AI-classroom work will appear here once a classroom completion reaches the bridge."
                  : transcript.note,
              )
        }
      </div>
      <aside class="panel panel--sticky">
        <p class="eyebrow">Next</p>
        <h2>Three things worth doing.</h2>
        <dl class="panel__facts">
          <div><dt>Register</dt><dd><a href="/portal/register">Term courses</a></dd></div>
          <div><dt>Read</dt><dd><a href="/portal/record">Your record</a></dd></div>
          <div><dt>Secure</dt><dd><a href="/portal/account">Password and address</a></dd></div>
        </dl>
        <p class="form-note">Fees are invoiced by the registrar. This portal does not take card details.</p>
      </aside>
    </div>
  </section>`;

  return layout({
    title: "Overview",
    surface: "portal",
    active: "dashboard",
    viewer: viewerFor(student),
    ctx,
    body,
  });
}

export function register(
  ctx: UiContext,
  student: Student,
  enrollments: Enrollment[],
  seatCounts: Record<string, number>,
  courses: CatalogCourse[],
  state: { error?: string; notice?: string } = {},
): string {
  const registered = new Set(
    enrollments.filter((item) => item.status === "registered" || item.status === "completed").map((item) => item.courseCode),
  );

  const terms = TERMS.map((term) => {
    const inTerm = courses.filter(
      (course) => course.termId === term.id && course.status === "published",
    );
    if (inTerm.length === 0) return "";
    return `<div class="term-block">
      <div class="term-block__head">
        <h2>${esc(term.name)}</h2>
        <span>${esc(term.starts)} — ${esc(term.ends)} · registration ${esc(term.registration)}</span>
      </div>
      ${inTerm
        .map((course) => {
          const taken = registered.has(course.code);
          const seats = Math.max(0, course.seats - (seatCounts[course.code] ?? 0));
          return `<div class="course-row">
            <span class="course-row__code">${esc(course.code)}</span>
            <div>
              <h3>${esc(course.title)}</h3>
              <p class="course-row__meta">${course.credits} credits · ${esc(course.instructor)} · ${esc(course.format)}</p>
            </div>
            <div class="course-row__seats"><strong>${course.credits} cr</strong></div>
            <div class="course-row__seats"><strong>${seats}</strong> of ${course.seats} seats</div>
            <div>
              ${
                taken
                  ? statusBadge("registered")
                  : term.registration === "open" && seats > 0
                    ? `<form method="post" action="/portal/register">
                        <input type="hidden" name="courseCode" value="${esc(course.code)}">
                        <button class="button button--small" type="submit">Register</button>
                      </form>`
                    : `<span class="badge badge--neutral">${term.registration === "open" ? "Full" : "Waitlist"}</span>`
              }
            </div>
          </div>`;
        })
        .join("")}
    </div>`;
  }).join("");

  const body = `
  ${pageHead({
    eyebrow: "Registration",
    breadcrumb: { href: "/portal/dashboard", label: "Overview" },
    title: "Register for classes.",
    lede: "Choose from the 2027–28 catalog. Your registration is recorded immediately and the seat is held for you; the registrar reconciles it with the LMS before teaching begins.",
  })}

  <section class="section">
    <div class="shell">
      ${state.error ? notice("error", state.error) : ""}
      ${state.notice ? notice("success", state.notice) : ""}
      <div class="panel mb-8">
        <p class="eyebrow">How registration works</p>
        <p class="flush">A seat is reserved when you register. If a studio is full, the button is disabled and the registrar keeps the waitlist. You can see everything you have registered for on your <a href="/portal/record">record</a>.</p>
      </div>
      ${terms}
    </div>
  </section>`;

  return layout({
    title: "Register",
    surface: "portal",
    active: "register",
    viewer: viewerFor(student),
    ctx,
    body,
  });
}

export function record(
  ctx: UiContext,
  student: Student,
  enrollments: Enrollment[],
  transcript: TranscriptResult,
  courses: CatalogCourse[],
): string {
  const completed = enrollments.filter((item) => item.status === "completed");
  const credits = completed.reduce((total, item) => total + (courseOf(courses, item.courseCode)?.credits ?? 0), 0);
  const program = programBySlug(student.programSlug);

  const body = `
  ${pageHead({
    eyebrow: "Academic record",
    breadcrumb: { href: "/portal/dashboard", label: "Overview" },
    title: "Your record.",
    lede: `Registrations, completions and awards for ${programLabel(student)}. This is a live view of the institution registry; the signed credential is the authoritative document.`,
    facts: [
      { label: "Student", value: `${student.firstName} ${student.lastName}` },
      { label: "Number", value: student.number },
      { label: "Credits completed", value: String(credits) },
      { label: "Program credits", value: String(program?.credits ?? 0) },
    ],
  })}

  <section class="section">
    <div class="shell">
      <div class="section-head">
        <div><p class="eyebrow">Courses</p><h2>Every registration.</h2></div>
        <div class="section-head__aside"><p>${completed.length} completed · ${enrollments.filter((item) => item.status === "registered").length} in progress.</p></div>
      </div>
      ${
        enrollments.length > 0
          ? `<div class="table-wrap"><table class="table">
              <thead><tr><th>Course</th><th>Term</th><th class="num">Credits</th><th>Registered</th><th>Status</th><th>Grade</th></tr></thead>
              <tbody>
                ${enrollments
                  .map((enrollment) => {
                    const course = courseOf(courses, enrollment.courseCode);
                    return `<tr>
                      <td><span class="strong">${esc(course?.title ?? enrollment.courseCode)}</span><span class="table__sub">${esc(enrollment.courseCode)}</span></td>
                      <td>${esc(termById(enrollment.termId)?.name ?? enrollment.termId)}</td>
                      <td class="num">${course?.credits ?? 0}</td>
                      <td>${esc(dateLabel(enrollment.registeredAt))}</td>
                      <td>${statusBadge(enrollment.status)}</td>
                      <td>${esc(enrollment.grade ?? "—")}</td>
                    </tr>`;
                  })
                  .join("")}
              </tbody>
            </table></div>`
          : emptyState("No courses on record", "Register for a term course and it will appear here immediately.", {
              href: "/portal/register",
              label: "Register for classes",
            })
      }
    </div>
  </section>

  <section class="section section--tint">
    <div class="shell split">
      <div>
        <div class="section-head">
          <div><p class="eyebrow">AI classrooms</p><h2>Work reported by the classroom.</h2></div>
          <div class="section-head__aside"><p>These entries come from the bridge's instruction ledger, not from this registry. A completion here does not by itself award a credential.</p></div>
        </div>
        ${
          transcript.entries.length > 0
            ? `<div class="table-wrap"><table class="table">
                <thead><tr><th>Course</th><th>Completed</th><th>Grade</th><th>Credential</th></tr></thead>
                <tbody>
                  ${transcript.entries
                    .map(
                      (entry) => `<tr>
                        <td>${esc(entry.courseKey ?? "—")}</td>
                        <td>${esc(dateLabel(entry.completedAt))}</td>
                        <td class="num">${entry.grade?.percent !== undefined ? `${entry.grade.percent}%` : "—"}</td>
                        <td>${entry.credential?.verifyId ? `<span class="code">${esc(entry.credential.verifyId)}</span>` : "—"}</td>
                      </tr>`,
                    )
                    .join("")}
                </tbody>
              </table></div>`
            : emptyState("No classroom entries", transcript.ok ? "Nothing has been reported for your learner id yet." : transcript.note)
        }
      </div>
      <aside class="panel panel--sticky">
        <p class="eyebrow">Credentials</p>
        <h2>Verifiable awards.</h2>
        <p>Certificates and degrees are signed and issued by the Institute's signing service. Each carries a verification identifier that a third party can check without contacting you.</p>
        <p class="form-note">Award decisions belong to the registrar and the Faculty Board, not to this portal.</p>
        <a class="button button--ghost" href="/verify">How verification works</a>
      </aside>
    </div>
  </section>`;

  return layout({
    title: "Academic record",
    surface: "portal",
    active: "record",
    viewer: viewerFor(student),
    ctx,
    body,
  });
}

export function account(
  ctx: UiContext,
  student: Student,
  state: { error?: string; notice?: string } = {},
): string {
  const program = programBySlug(student.programSlug);
  const term = termById(student.termId);
  const body = `
  ${pageHead({
    eyebrow: "Account",
    breadcrumb: { href: "/portal/dashboard", label: "Overview" },
    title: "Your account.",
    lede: "The identity the Institute issued you. Your student number and AthenIQ address are permanent; your password is yours to change.",
    facts: [
      { label: "Student number", value: student.number },
      { label: "AthenIQ email", value: student.schoolEmail },
      { label: "Mailbox", value: student.mailbox.status },
      { label: "Program", value: program?.credential ?? student.programSlug },
    ],
  })}

  <section class="section">
    <div class="shell split">
      <div>
        <div class="section-head">
          <div><p class="eyebrow">Details</p><h2>What the registry holds.</h2></div>
        </div>
        <div class="detail-grid">
          <div class="detail"><dt>Full name</dt><dd>${esc(student.firstName)} ${esc(student.lastName)}</dd></div>
          <div class="detail"><dt>Student number</dt><dd><span class="code">${esc(student.number)}</span></dd></div>
          <div class="detail"><dt>AthenIQ email</dt><dd>${esc(student.schoolEmail)}</dd></div>
          <div class="detail"><dt>Personal email</dt><dd>${esc(student.personalEmail)}</dd></div>
          <div class="detail"><dt>Program</dt><dd>${esc(program ? `${program.credential} ${program.name}` : student.programSlug)}</dd></div>
          <div class="detail"><dt>Intake</dt><dd>${esc(term?.name ?? student.termId)}</dd></div>
          <div class="detail"><dt>Mailbox</dt><dd>${statusBadge(student.mailbox.status)} · ${esc(student.mailbox.provider)}</dd></div>
          <div class="detail"><dt>Enrolled</dt><dd>${esc(dateLabel(student.createdAt))}</dd></div>
        </div>
        ${state.error ? notice("error", state.error) : ""}
        ${state.notice ? notice("success", state.notice) : ""}
        <div class="section-head mt-12">
          <div><p class="eyebrow">Security</p><h2>Change your password.</h2></div>
          <div class="section-head__aside"><p>At least ten characters. Changing it signs out nothing else — sessions expire after eight hours.</p></div>
        </div>
        <form method="post" action="/portal/password" class="form-row">
          ${field({ label: "Current password", name: "current", type: "password", autocomplete: "current-password", required: true })}
          ${field({ label: "New password", name: "next", type: "password", autocomplete: "new-password", required: true, hint: "At least 10 characters." })}
          <div class="field"><label for="confirm">Confirm new password</label><input id="confirm" name="confirm" type="password" autocomplete="new-password" required></div>
          <div class="field field--action"><button class="button" type="submit">Update password</button></div>
        </form>
        <p class="form-note">Need a new temporary password? The registrar can issue one; you will be asked to change it at sign-in.</p>
      </div>
      <aside class="panel panel--sticky">
        <p class="eyebrow">Mailbox</p>
        <h2>${esc(student.schoolEmail)}</h2>
        <p>The address is reserved in the Institute directory. Delivery is switched on by the Institute's mail provider; until then, the registrar can reach you at your personal email.</p>
        <dl class="panel__facts">
          <div><dt>Status</dt><dd>${statusBadge(student.mailbox.status)}</dd></div>
          <div><dt>Provider</dt><dd>${esc(student.mailbox.provider)}</dd></div>
          <div><dt>Reserved</dt><dd>${esc(dateLabel(student.mailbox.provisionedAt))}</dd></div>
        </dl>
        <a class="button button--ghost" href="mailto:registrar@${esc(ctx.mailDomain)}">Contact the registrar</a>
      </aside>
    </div>
  </section>`;

  return layout({ title: "Account", surface: "portal", active: "account", viewer: viewerFor(student), ctx, body });
}

export function password(
  ctx: UiContext,
  student: Student,
  state: { error?: string; forced?: boolean } = {},
): string {
  const body = `
  <div class="auth">
    <aside class="auth__aside">
      <div>
        <p class="eyebrow">Account security</p>
        <h2>Set a password only you know.</h2>
        <p>The registrar issued you a temporary password so you could sign in. Replace it now; the temporary one stops working immediately.</p>
      </div>
      <ul class="auth__list">
        <li>At least ten characters.</li>
        <li>A phrase is stronger than a word with a number on the end.</li>
        <li>The Institute will never ask you for this password by email.</li>
      </ul>
    </aside>
    <div class="auth__main">
      <div class="auth__form">
        <p class="eyebrow">${state.forced ? "First sign-in" : "Account"}</p>
        <h1>Change your password</h1>
        <p>Signed in as <strong>${esc(student.schoolEmail)}</strong>.</p>
        ${state.error ? notice("error", state.error) : ""}
        ${state.forced ? notice("info", "You are using a temporary password. Choose your own to continue.") : ""}
        <form method="post" action="/portal/password">
          ${field({ label: "Current password", name: "current", type: "password", autocomplete: "current-password", required: true })}
          ${field({ label: "New password", name: "next", type: "password", autocomplete: "new-password", required: true, hint: "At least 10 characters." })}
          <div class="field"><label for="confirm">Confirm new password</label><input id="confirm" name="confirm" type="password" autocomplete="new-password" required></div>
          <button class="button" type="submit">Set password</button>
        </form>
        <p class="form-note"><a href="/portal/signout">Sign out</a> instead.</p>
      </div>
    </div>
  </div>`;

  return layout({
    title: "Change password",
    surface: "portal",
    active: "account",
    viewer: viewerFor(student),
    ctx,
    body,
  });
}


/**
 * The registrar: the management surface at registrar.atheniq.institute.
 *
 * It is where an application becomes a student — student number, portal
 * account and @atheniq.institute mailbox in one write — and where a student's
 * access is reset. Awards and academic decisions remain with the console and
 * the Faculty Board; this surface does not pretend to own them.
 */

import { courseByCode, programBySlug, termById } from "../content.ts";
import type { RegistrySummary } from "../registry.ts";
import type { Application, Enrollment, Student } from "../store.ts";
import {
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

function staffViewer(email: string) {
  return { name: email, role: "registrar" as const };
}

export function signIn(ctx: UiContext, state: { error?: string; email?: string } = {}): string {
  const body = `
  <div class="auth">
    <aside class="auth__aside">
      <div>
        <p class="eyebrow">Registrar</p>
        <h2>Admissions, accounts and the student record.</h2>
        <p>One decision admits an applicant, issues a student number, creates a portal account and reserves an <strong>@${esc(ctx.mailDomain)}</strong> address. All of it is one write.</p>
      </div>
      <ul class="auth__list">
        <li>Read and decide applications.</li>
        <li>Issue and reset student access.</li>
        <li>See registrations and mailbox state.</li>
        <li>Hand academic awards to the console.</li>
      </ul>
    </aside>
    <div class="auth__main">
      <div class="auth__form">
        <p class="eyebrow">Staff sign-in</p>
        <h1>Registrar</h1>
        <p>This surface is separate from the student portal and is not linked from it.</p>
        ${state.error ? notice("error", state.error) : ""}
        <form method="post" action="/signin">
          ${field({ label: "Staff email", name: "email", type: "email", value: state.email, autocomplete: "username", inputmode: "email", required: true })}
          ${field({ label: "Password", name: "password", type: "password", autocomplete: "current-password", required: true })}
          <button class="button" type="submit">Sign in</button>
        </form>
        ${
          ctx.demo
            ? `<div class="alert alert--info mt-6"><p><strong>Preview access.</strong><br>registrar@${esc(ctx.mailDomain)} · atheniq-registrar</p></div>`
            : `<p class="form-note">Staff access is provisioned by the Institute. There is no self-service sign-up.</p>`
        }
        <p class="form-note"><a href="${esc(ctx.publicOrigin)}">Return to the public site</a></p>
      </div>
    </div>
  </div>`;

  return layout({ title: "Registrar sign-in", surface: "registrar", viewer: null, ctx, body, description: "AthenIQ Institute registrar." });
}

export function dashboard(
  ctx: UiContext,
  summary: RegistrySummary,
  applications: Application[],
  students: Student[],
): string {
  const recent = applications.slice(0, 5);
  const body = `
  ${pageHead({
    eyebrow: "Registrar",
    title: "Today at the Institute.",
    lede: "The admissions queue, the student roster and the state of account issuance. Everything here is scoped to this institution; nothing is shared with the public site.",
    facts: [
      { label: "Awaiting decision", value: String(summary.awaitingDecision) },
      { label: "Students", value: String(summary.students) },
      { label: "Registrations", value: String(summary.registrations) },
      { label: "Mailboxes reserved", value: String(summary.mailboxesReserved) },
    ],
  })}

  <section class="section section--tight">
    <div class="shell">
      <div class="metrics">
        ${metric(String(summary.awaitingDecision), "awaiting a decision")}
        ${metric(String(summary.students), "students on the roster")}
        ${metric(String(summary.registrations), "open registrations")}
        ${metric(String(summary.mailboxesReserved), "mailboxes awaiting activation")}
      </div>
      <div class="split">
        <div>
          <div class="section-head">
            <div><p class="eyebrow">Admissions</p><h2>Recent applications.</h2></div>
            <div class="section-head__aside">
              <p>Applications are read in the order they arrive. Admission issues the account immediately.</p>
              <a class="textlink textlink--arrow" href="/applications">All applications <span aria-hidden="true">→</span></a>
            </div>
          </div>
          ${
            recent.length > 0
              ? `<div class="table-wrap"><table class="table">
                  <thead><tr><th>Applicant</th><th>Program</th><th>Intake</th><th>Submitted</th><th>Status</th></tr></thead>
                  <tbody>
                    ${recent
                      .map(
                        (application) => `<tr>
                          <td><a href="/applications/${esc(application.id)}"><span class="strong">${esc(application.firstName)} ${esc(application.lastName)}</span></a><span class="table__sub">${esc(application.email)}</span></td>
                          <td>${esc(programBySlug(application.programSlug)?.name ?? application.programSlug)}</td>
                          <td>${esc(termById(application.termId)?.name ?? application.termId)}</td>
                          <td>${esc(dateLabel(application.submittedAt))}</td>
                          <td>${statusBadge(application.status)}</td>
                        </tr>`,
                      )
                      .join("")}
                  </tbody>
                </table></div>`
              : emptyState("No applications yet", "Applications submitted on the public site appear here immediately.")
          }
        </div>
        <aside class="panel panel--sticky">
          <p class="eyebrow">Account issuance</p>
          <h2>What admission creates.</h2>
          <dl class="panel__facts">
            <div><dt>Student number</dt><dd>ATH-YYYY-NNNN</dd></div>
            <div><dt>Portal account</dt><dd>First sign-in at the portal</dd></div>
            <div><dt>AthenIQ email</dt><dd>first.last@${esc(ctx.mailDomain)}</dd></div>
            <div><dt>Mailbox</dt><dd>Reserved, then activated</dd></div>
            <div><dt>Temporary password</dt><dd>Shown once to you</dd></div>
          </dl>
          <p class="form-note">The temporary password is displayed once, on the admission confirmation. It cannot be recovered; issue a reset instead.</p>
          <a class="button button--ghost" href="/students">Open the roster</a>
        </aside>
      </div>
    </div>
  </section>

  <section class="section section--tint section--tight">
    <div class="shell">
      <div class="section-head">
        <div><p class="eyebrow">Roster</p><h2>Newest students.</h2></div>
        <div class="section-head__aside"><p>Mailbox state is tracked per student. A reserved address exists in the directory and is waiting on the mail provider.</p></div>
      </div>
      ${
        students.length > 0
          ? `<div class="table-wrap"><table class="table">
              <thead><tr><th>Student</th><th>Number</th><th>Program</th><th>Intake</th><th>Mailbox</th></tr></thead>
              <tbody>
                ${students
                  .slice(-5)
                  .reverse()
                  .map(
                    (student) => `<tr>
                      <td><a href="/students/${esc(student.id)}"><span class="strong">${esc(student.firstName)} ${esc(student.lastName)}</span></a><span class="table__sub">${esc(student.schoolEmail)}</span></td>
                      <td class="num">${esc(student.number)}</td>
                      <td>${esc(programBySlug(student.programSlug)?.name ?? student.programSlug)}</td>
                      <td>${esc(termById(student.termId)?.name ?? student.termId)}</td>
                      <td>${statusBadge(student.mailbox.status)}</td>
                    </tr>`,
                  )
                  .join("")}
              </tbody>
            </table></div>`
          : emptyState("No students yet", "Admit an applicant and their account appears here in the same write.")
      }
    </div>
  </section>`;

  return layout({ title: "Registrar", surface: "registrar", active: "dashboard", viewer: staffViewer(ctx.demo ? `registrar@${ctx.mailDomain}` : "Staff"), ctx, body });
}

export function applications(ctx: UiContext, list: Application[]): string {
  const body = `
  ${pageHead({
    eyebrow: "Admissions",
    breadcrumb: { href: "/", label: "Today" },
    title: "Applications.",
    lede: "Every application, newest first. Admission is irreversible from this surface: it creates the account and the student number, and a correction is a registrar action, not a delete.",
    facts: [
      { label: "Total", value: String(list.length) },
      { label: "Awaiting decision", value: String(list.filter((item) => item.status === "submitted" || item.status === "under_review").length) },
      { label: "Admitted", value: String(list.filter((item) => item.status === "admitted").length) },
    ],
  })}

  <section class="section section--tight">
    <div class="shell">
      ${
        list.length > 0
          ? `<div class="table-wrap"><table class="table">
              <thead><tr><th>Applicant</th><th>Program</th><th>Intake</th><th>Submitted</th><th>Status</th><th></th></tr></thead>
              <tbody>
                ${list
                  .map(
                    (application) => `<tr>
                      <td><span class="strong">${esc(application.firstName)} ${esc(application.lastName)}</span><span class="table__sub">${esc(application.email)} · ${esc(application.country)}</span></td>
                      <td>${esc(programBySlug(application.programSlug)?.name ?? application.programSlug)}</td>
                      <td>${esc(termById(application.termId)?.name ?? application.termId)}</td>
                      <td>${esc(dateLabel(application.submittedAt))}</td>
                      <td>${statusBadge(application.status)}</td>
                      <td><a class="textlink" href="/applications/${esc(application.id)}">Open</a></td>
                    </tr>`,
                  )
                  .join("")}
              </tbody>
            </table></div>`
          : emptyState("No applications", "The public application form writes here. If the public site is live and this is empty, check that both hosts share the same data directory.", {
              href: "/",
              label: "Back to today",
            })
      }
    </div>
  </section>`;

  return layout({ title: "Applications", surface: "registrar", active: "applications", viewer: staffViewer("Staff"), ctx, body });
}

export function applicationDetail(
  ctx: UiContext,
  application: Application,
  state: {
    error?: string;
    notice?: string;
    credentials?: { studentId: string; number: string; email: string; tempPassword: string };
  } = {},
): string {
  const program = programBySlug(application.programSlug);
  const term = termById(application.termId);
  const body = `
  ${pageHead({
    eyebrow: "Application",
    breadcrumb: { href: "/applications", label: "Applications" },
    title: `${application.firstName} ${application.lastName}`,
    lede: `${program ? `${program.credential} ${program.name}` : application.programSlug} · ${term?.name ?? application.termId} · submitted ${dateLabel(application.submittedAt)}`,
    facts: [
      { label: "Reference", value: application.id },
      { label: "Status", value: application.status.replace("_", " ") },
      { label: "Email", value: application.email },
      { label: "Country", value: application.country },
    ],
  })}

  <section class="section">
    <div class="shell split">
      <div>
        ${state.error ? notice("error", state.error) : ""}
        ${state.notice ? notice("success", state.notice) : ""}
        ${
          state.credentials
            ? `<div class="panel mb-8">
                <p class="eyebrow">Account issued</p>
                <h2>Hand these over securely.</h2>
                <p>The student number and address are permanent. The temporary password is shown once and must be changed at first sign-in.</p>
                <div class="detail-grid">
                  <div class="detail"><dt>Student number</dt><dd><span class="code">${esc(state.credentials.number)}</span></dd></div>
                  <div class="detail"><dt>AthenIQ email</dt><dd>${esc(state.credentials.email)}</dd></div>
                </div>
                <p class="eyebrow">Temporary password</p>
                <span class="secret">${esc(state.credentials.tempPassword)}</span>
                <p class="form-note">Portal: <a href="${esc(ctx.publicOrigin)}/portal">${esc(ctx.publicOrigin)}/portal</a>. If this page is lost before you hand it over, open the student record and issue a reset.</p>
                <a class="button button--ghost" href="/students/${esc(state.credentials.studentId)}">Open the student record</a>
              </div>`
            : ""
        }
        <div class="section-head">
          <div><p class="eyebrow">Statement</p><h2>In their words.</h2></div>
        </div>
        <blockquote class="panel statement">
          ${esc(application.statement).replace(/\n/g, "<br>")}
        </blockquote>
        <div class="detail-grid mt-8">
          <div class="detail"><dt>Program</dt><dd>${esc(program ? `${program.credential} ${program.name}` : application.programSlug)}</dd></div>
          <div class="detail"><dt>Intake</dt><dd>${esc(term?.name ?? application.termId)}</dd></div>
          <div class="detail"><dt>Fee</dt><dd>${esc(program?.tuitionNote ?? "—")}</dd></div>
          <div class="detail"><dt>Deadline</dt><dd>${esc(program?.applicationDeadline ?? "—")}</dd></div>
          <div class="detail"><dt>Decided</dt><dd>${esc(dateLabel(application.decidedAt))}</dd></div>
          <div class="detail"><dt>Note</dt><dd>${esc(application.decisionNote ?? "—")}</dd></div>
        </div>
      </div>
      <aside class="panel panel--sticky">
        <p class="eyebrow">Decision</p>
        <h2>${application.status === "admitted" ? "Admitted" : application.status === "denied" ? "Declined" : "Admit or decline."}</h2>
        ${
          application.status === "admitted"
            ? `<p>${statusBadge("admitted")} This applicant is a student. Use the roster for access resets and registration questions.</p>
               ${application.studentId ? `<a class="button button--ghost" href="/students/${esc(application.studentId)}">Student record</a>` : ""}`
            : application.status === "denied"
              ? `<p>${statusBadge("denied")} This application was declined. A new application for a later intake is allowed.</p>`
              : `<p>Admission creates the student number, the portal account and the mailbox reservation in one write. It cannot be undone here.</p>
                 <form method="post" action="/applications/${esc(application.id)}/decision">
                   <div class="field">
                     <label for="note">Note (optional)</label>
                     <textarea id="note" name="note" rows="4" maxlength="500" placeholder="Interview outcome, conditions, or reason for declining."></textarea>
                   </div>
                   <div class="actions">
                     <button class="button" type="submit" name="decision" value="admit">Admit and issue account</button>
                     <button class="button button--danger" type="submit" name="decision" value="deny">Decline</button>
                   </div>
                 </form>`
        }
        <dl class="panel__facts mt-6">
          <div><dt>Portal account</dt><dd>Created on admission</dd></div>
          <div><dt>Mailbox</dt><dd>Reserved on admission</dd></div>
          <div><dt>Credentials</dt><dd>Issued by the console</dd></div>
        </dl>
      </aside>
    </div>
  </section>`;

  return layout({
    title: `${application.firstName} ${application.lastName}`,
    surface: "registrar",
    active: "applications",
    viewer: staffViewer("Staff"),
    ctx,
    body,
  });
}

export function students(ctx: UiContext, list: Student[]): string {
  const body = `
  ${pageHead({
    eyebrow: "Roster",
    breadcrumb: { href: "/", label: "Today" },
    title: "Students.",
    lede: "Every enrolled student, with the identity the Institute issued: student number, AthenIQ address and mailbox state.",
    facts: [
      { label: "Students", value: String(list.length) },
      { label: "Active", value: String(list.filter((item) => item.status === "active").length) },
      { label: "Mailboxes reserved", value: String(list.filter((item) => item.mailbox.status === "reserved").length) },
    ],
  })}

  <section class="section section--tight">
    <div class="shell">
      ${
        list.length > 0
          ? `<div class="table-wrap"><table class="table">
              <thead><tr><th>Student</th><th>Number</th><th>Program</th><th>Intake</th><th>Mailbox</th><th>Status</th><th></th></tr></thead>
              <tbody>
                ${list
                  .map(
                    (student) => `<tr>
                      <td><span class="strong">${esc(student.firstName)} ${esc(student.lastName)}</span><span class="table__sub">${esc(student.schoolEmail)}</span></td>
                      <td class="num">${esc(student.number)}</td>
                      <td>${esc(programBySlug(student.programSlug)?.name ?? student.programSlug)}</td>
                      <td>${esc(termById(student.termId)?.name ?? student.termId)}</td>
                      <td>${statusBadge(student.mailbox.status)}</td>
                      <td>${statusBadge(student.status)}</td>
                      <td><a class="textlink" href="/students/${esc(student.id)}">Open</a></td>
                    </tr>`,
                  )
                  .join("")}
              </tbody>
            </table></div>`
          : emptyState("No students", "Admit an applicant and their account appears here.")
      }
    </div>
  </section>`;

  return layout({ title: "Students", surface: "registrar", active: "students", viewer: staffViewer("Staff"), ctx, body });
}

export function studentDetail(
  ctx: UiContext,
  student: Student,
  enrollments: Enrollment[],
  state: { error?: string; notice?: string; tempPassword?: string } = {},
): string {
  const program = programBySlug(student.programSlug);
  const term = termById(student.termId);
  const body = `
  ${pageHead({
    eyebrow: "Student",
    breadcrumb: { href: "/students", label: "Students" },
    title: `${student.firstName} ${student.lastName}`,
    lede: `${program ? `${program.credential} ${program.name}` : student.programSlug} · ${term?.name ?? student.termId} · enrolled ${dateLabel(student.createdAt)}`,
    facts: [
      { label: "Student number", value: student.number },
      { label: "AthenIQ email", value: student.schoolEmail },
      { label: "Mailbox", value: student.mailbox.status },
      { label: "Status", value: student.status },
    ],
  })}

  <section class="section">
    <div class="shell split">
      <div>
        ${state.error ? notice("error", state.error) : ""}
        ${state.notice ? notice("success", state.notice) : ""}
        ${
          state.tempPassword
            ? `<div class="panel mb-8">
                <p class="eyebrow">Access reset</p>
                <h2>New temporary password.</h2>
                <p>Shown once. The student must change it at first sign-in; the previous password no longer works.</p>
                <span class="secret">${esc(state.tempPassword)}</span>
              </div>`
            : ""
        }
        <div class="section-head">
          <div><p class="eyebrow">Identity</p><h2>Issued account.</h2></div>
        </div>
        <div class="detail-grid">
          <div class="detail"><dt>Student id</dt><dd><span class="code">${esc(student.id)}</span></dd></div>
          <div class="detail"><dt>Student number</dt><dd><span class="code">${esc(student.number)}</span></dd></div>
          <div class="detail"><dt>AthenIQ email</dt><dd>${esc(student.schoolEmail)}</dd></div>
          <div class="detail"><dt>Personal email</dt><dd>${esc(student.personalEmail)}</dd></div>
          <div class="detail"><dt>Mailbox</dt><dd>${statusBadge(student.mailbox.status)} · ${esc(student.mailbox.provider)}</dd></div>
          <div class="detail"><dt>Reserved</dt><dd>${esc(dateLabel(student.mailbox.provisionedAt))}</dd></div>
          <div class="detail"><dt>Account state</dt><dd>${statusBadge(student.status)}</dd></div>
          <div class="detail"><dt>Password</dt><dd>${student.mustChangePassword ? "Temporary — change required" : "Set by the student"}</dd></div>
        </div>

        <div class="section-head mt-12">
          <div><p class="eyebrow">Registrations</p><h2>Courses on record.</h2></div>
          <div class="section-head__aside"><p>Students register from their portal. The registrar reconciles the list with the LMS before teaching begins.</p></div>
        </div>
        ${
          enrollments.length > 0
            ? `<div class="table-wrap"><table class="table">
                <thead><tr><th>Course</th><th>Term</th><th class="num">Credits</th><th>Registered</th><th>Status</th></tr></thead>
                <tbody>
                  ${enrollments
                    .map(
                      (enrollment) => `<tr>
                        <td><span class="strong">${esc(courseByCode(enrollment.courseCode)?.title ?? enrollment.courseCode)}</span><span class="table__sub">${esc(enrollment.courseCode)}</span></td>
                        <td>${esc(termById(enrollment.termId)?.name ?? enrollment.termId)}</td>
                        <td class="num">${courseByCode(enrollment.courseCode)?.credits ?? 0}</td>
                        <td>${esc(dateLabel(enrollment.registeredAt))}</td>
                        <td>${statusBadge(enrollment.status)}</td>
                      </tr>`,
                    )
                    .join("")}
                </tbody>
              </table></div>`
            : emptyState("No registrations", "The student has not registered for a course yet.")
        }
      </div>
      <aside class="panel panel--sticky">
        <p class="eyebrow">Access</p>
        <h2>Issue a reset.</h2>
        <p>Generates a new temporary password and requires a change at next sign-in. The old password stops working immediately.</p>
        <form method="post" action="/students/${esc(student.id)}/reset">
          <button class="button button--danger" type="submit">Reset access</button>
        </form>
        <dl class="panel__facts mt-6">
          <div><dt>Portal</dt><dd><a href="${esc(ctx.publicOrigin)}/portal">Student sign-in</a></dd></div>
          <div><dt>Mailbox</dt><dd>${esc(student.schoolEmail)}</dd></div>
          <div><dt>Awards</dt><dd>${ctx.consoleUrl ? `<a href="${esc(ctx.consoleUrl)}">Console</a>` : "Console not configured"}</dd></div>
        </dl>
        <p class="form-note">A reset is logged by the time it is issued. It does not reveal the student's chosen password.</p>
      </aside>
    </div>
  </section>`;

  return layout({ title: `${student.firstName} ${student.lastName}`, surface: "registrar", active: "students", viewer: staffViewer("Staff"), ctx, body });
}


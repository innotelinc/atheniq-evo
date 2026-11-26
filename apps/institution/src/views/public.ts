/**
 * The public institution site: what the Institute is, what it teaches, how to
 * apply, and how to check an award.
 *
 * Pages are strings. There is no client framework and no build step: the site
 * is served by the same process that owns admissions, so a deploy is one
 * artifact and a page cannot drift from the rules it describes.
 */

import {
  FAQ,
  FACULTY,
  PRINCIPLES,
  PROGRAMS,
  STATS,
  TERMS,
  applicationCycle,
  applicationWindowLabel,
  formatDate,
  intakeTerms,
  openApplicationTerms,
  registrationLabel,
  timelineFor,
  type Program,
  type Term,
} from "../content.ts";
import type { CatalogCourse } from "../catalog.ts";
import type { Application } from "../store.ts";
import type { ApplicationInput } from "../registry.ts";
import {
  checkboxField,
  dateLabel,
  esc,
  field,
  layout,
  money,
  notice,
  courseOf,
  pageHead,
  programCard,
  sectionHead,
  selectField,
  textareaField,
  type Surface,
  type UiContext,
  type Viewer,
} from "../ui.ts";

function principleCards(): string {
  return `<div class="principles">${PRINCIPLES.map(
    (principle, index) => `<div class="principle">
      <span class="principle__index">${String(index + 1).padStart(2, "0")}</span>
      <h3>${esc(principle.title)}</h3>
      <p>${esc(principle.body)}</p>
    </div>`,
  ).join("")}</div>`;
}

function statCards(): string {
  return `<div class="stats">${STATS.map(
    (stat) => `<div class="stat"><span class="stat__value">${esc(stat.value)}</span><span class="stat__label">${esc(stat.label)}</span></div>`,
  ).join("")}</div>`;
}

function facultyCards(limit?: number): string {
  const members = limit === undefined ? FACULTY : FACULTY.slice(0, limit);
  return `<div class="faculty-grid">${members
    .map(
      (member) => `<div class="faculty">
        <span class="faculty__initials" aria-hidden="true">${esc(member.initials)}</span>
        <h3>${esc(member.name)}</h3>
        <p class="faculty__role">${esc(member.role)} · ${esc(member.field)}</p>
        <p>${esc(member.bio)}</p>
      </div>`,
    )
    .join("")}</div>`;
}

function timelineRows(term: Term): string {
  return `<div class="timeline">${timelineFor(term).map(
    (item) => `<div class="timeline__row">
      <span class="timeline__date">${esc(item.date)}</span>
      <h3>${esc(item.title)}</h3>
      <p>${esc(item.body)}</p>
    </div>`,
  ).join("")}</div>`;
}

function ctaBand(input: {
  eyebrow: string;
  title: string;
  body?: string;
  href: string;
  label: string;
}): string {
  return `<section class="band band--ink">
    <div class="shell cta">
      <div>
        <p class="eyebrow">${esc(input.eyebrow)}</p>
        <h2>${esc(input.title)}</h2>
        ${input.body ? `<p>${esc(input.body)}</p>` : ""}
      </div>
      <a class="button button--light" href="${esc(input.href)}">${esc(input.label)}</a>
    </div>
  </section>`;
}

export function home(ctx: UiContext): string {
  const cycle = applicationCycle();
  const body = `
  <section class="hero">
    <div class="shell hero__inner">
      <div>
        <p class="eyebrow">AthenIQ Institute · An institute for the age of machine intelligence</p>
        <h1>Learn deeply. Build what comes next.</h1>
        <p class="hero__lede">Small cohorts, studio teaching and an AI classroom that knows the material and the learner. Degrees and credentials that anyone can verify.</p>
        <div class="actions">
          <a class="button" href="/admissions/apply">Begin an application</a>
          <a class="button button--ghost" href="/academics">Explore programs</a>
        </div>
        <p class="hero__note">${esc(cycle.name)} intake · priority deadline ${esc(formatDate(cycle.applicationsPriority))} · no application fee</p>
      </div>
      <aside class="hero__panel">
        <p class="eyebrow">At a glance</p>
        <dl class="facts">
          <div><dt>Student–faculty ratio</dt><dd>6 : 1</dd></div>
          <div><dt>Maximum studio</dt><dd>18</dd></div>
          <div><dt>Intakes each year</dt><dd>3</dd></div>
          <div><dt>Format</dt><dd>Online-first</dd></div>
        </dl>
        <p class="hero__panel-foot">Every enrolled student receives a student account, a student number and an <strong>@${esc(ctx.mailDomain)}</strong> address.</p>
      </aside>
    </div>
  </section>

  <section class="band band--rules">
    <div class="shell">${principleCards()}</div>
  </section>

  <section class="section">
    <div class="shell">
      ${sectionHead({
        eyebrow: "Programs",
        title: "Four ways in. One standard of work.",
        lede: "Undergraduate, graduate and professional study in applied artificial intelligence, machine intelligence and public interest technology. Every program ends with something built, evaluated and defended.",
        action: { href: "/academics", label: "All programs" },
      })}
      <div class="program-grid">
        ${PROGRAMS.map((program, index) => programCard(program, index)).join("")}
      </div>
    </div>
  </section>

  <section class="section section--tint">
    <div class="shell">
      ${sectionHead({
        eyebrow: "How it works",
        title: "From application to account in four months.",
        lede: "Admission is a conversation about what you want to build, not a filter on the name of your degree. Once you accept an offer, the administrative half is deliberately quiet.",
      })}
      <div class="steps">
        <div class="step">
          <span class="step__number">01</span>
          <h3>Apply in twenty minutes</h3>
          <p>Choose a program and intake, write a short statement, and tell us how to reach you. There is no fee and no entrance examination.</p>
        </div>
        <div class="step">
          <span class="step__number">02</span>
          <h3>Talk to faculty</h3>
          <p>A thirty-minute conversation with someone who teaches the program. We are looking for evidence that you can do the work, and for what you want to do with it.</p>
        </div>
        <div class="step">
          <span class="step__number">03</span>
          <h3>Enroll and receive your account</h3>
          <p>Accept your offer and the Institute issues your student number, your student portal account and an <strong>@${esc(ctx.mailDomain)}</strong> address.</p>
        </div>
      </div>
      <p class="form-note">Registration for term-one courses opens in August 2027, from the student portal.</p>
    </div>
  </section>

  <section class="band band--ink section--tight">
    <div class="shell">
      <div class="quote">
        <blockquote>
          <p>“We are not teaching people to prompt a model. We are teaching them to be responsible for a system.”</p>
          <cite class="quote__cite">Dr. Amara Okonjo · Dean of Faculty</cite>
        </blockquote>
        ${statCards()}
      </div>
    </div>
  </section>

  <section class="section">
    <div class="shell">
      ${sectionHead({
        eyebrow: "Faculty",
        title: "People who have built, regulated and taught these systems.",
        lede: "Six faculty, deliberately. Every student is taught by the person who designs the assessment.",
        action: { href: "/about#faculty", label: "Meet the faculty" },
      })}
      ${facultyCards(3)}
    </div>
  </section>

  <section class="section section--tint">
    <div class="shell">
      ${sectionHead({
        eyebrow: "Admissions",
        title: `The ${cycle.name} calendar.`,
        lede: "Applications are read in the order they arrive. Priority applicants are interviewed first and considered for every scholarship round.",
        action: { href: "/admissions", label: "Admissions and fees" },
      })}
      ${timelineRows(cycle)}
    </div>
  </section>

  ${ctaBand({
    eyebrow: cycle.name,
    title: "Start with a conversation about what you want to build.",
    body: "Applications take about twenty minutes. If you are unsure which program fits, apply to the closest one and tell us — we will read it properly.",
    href: "/admissions/apply",
    label: "Begin an application",
  })}`;

  return layout({
    title: "",
    surface: "public",
    active: "home",
    ctx,
    body,
    description:
      "AthenIQ Institute — applied artificial intelligence, machine intelligence and public interest technology. Small cohorts, studio teaching, verifiable credentials.",
  });
}

export function academics(ctx: UiContext, catalog: CatalogCourse[]): string {
  const curriculumCodes = [
    ...new Set([
      ...PROGRAMS.flatMap((program) => program.curriculum.flatMap((block) => block.courses)),
      // A course the console attached to a program belongs in the schedule even
      // when the program's written plan has not been edited yet.
      ...catalog
        .filter((course) => course.status === "published" && course.programs.length > 0)
        .map((course) => course.code),
    ]),
  ];

  const body = `
  ${pageHead({
    eyebrow: "Academics",
    title: "A curriculum built around what you can defend.",
    lede: "Four programs, one method: small studios, weekly building, fortnightly critique, and an assessment you present rather than sit. The catalog below is the full teaching schedule for the 2027–28 year.",
  })}

  <section class="section">
    <div class="shell">
      ${sectionHead({
        eyebrow: "Programs",
        title: "Choose the depth you need.",
        lede: "A three-year degree, two one-year masters, and a part-time certificate for people already responsible for these systems.",
      })}
      <div class="program-grid">
        ${PROGRAMS.map((program, index) => programCard(program, index)).join("")}
      </div>
    </div>
  </section>

  <section class="section section--tint">
    <div class="shell">
      ${sectionHead({
        eyebrow: "Course catalog",
        title: "Every course taught in 2027–28.",
        lede: "Enrolled students register from the portal. Seats are real: a full studio is full, and the registrar keeps the waitlist.",
      })}
      ${TERMS.map((term) => {
        const courses = curriculumCodes
          .map((code) => courseOf(catalog, code))
          .filter((course): course is NonNullable<typeof course> => Boolean(course))
          .filter((course) => course.termId === term.id && course.status !== "archived");
        if (courses.length === 0) return "";
        return `<div class="term-block">
          <div class="term-block__head">
            <h2>${esc(term.name)}</h2>
            <span>${esc(formatDate(term.starts))} — ${esc(formatDate(term.ends))} · registration ${esc(registrationLabel(term))}</span>
          </div>
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>Code</th><th>Course</th><th class="num">Credits</th><th>Instructor</th><th>Format</th></tr></thead>
              <tbody>
                ${courses
                  .map(
                    (course) => `<tr>
                      <td class="num">${esc(course.code)}</td>
                      <td><span class="strong">${esc(course.title)}</span><span class="table__sub">${esc(course.summary)}</span></td>
                      <td class="num">${course.credits}</td>
                      <td>${esc(course.instructor)}</td>
                      <td>${esc(course.format)}</td>
                    </tr>`,
                  )
                  .join("")}
              </tbody>
            </table>
          </div>
        </div>`;
      }).join("")}
    </div>
  </section>

  ${ctaBand({
    eyebrow: "Next step",
    title: "Find the program that matches the work you want to do.",
    href: "/admissions",
    label: "Admissions and fees",
  })}`;

  return layout({ title: "Academics", surface: "public", active: "academics", ctx, body });
}

export function programPage(ctx: UiContext, program: Program, catalog: CatalogCourse[]): string {
  const cycle = applicationCycle();
  const curriculum = program.curriculum
    .map(
      (block) => `<div class="term-block">
        <div class="term-block__head"><h2>${esc(block.term)}</h2><span>${block.courses.length} courses</span></div>
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>Code</th><th>Course</th><th class="num">Credits</th><th>Instructor</th></tr></thead>
            <tbody>
              ${block.courses
                .map((code) => {
                  const course = courseOf(catalog, code);
                  if (!course || course.status === "archived") return "";
                  return `<tr>
                    <td class="num">${esc(course.code)}</td>
                    <td><span class="strong">${esc(course.title)}</span><span class="table__sub">${esc(course.summary)}</span></td>
                    <td class="num">${course.credits}</td>
                    <td>${esc(course.instructor)}</td>
                  </tr>`;
                })
                .join("")}
            </tbody>
          </table>
        </div>
      </div>`,
    )
    .join("");

  const body = `
  ${pageHead({
    eyebrow: program.level,
    breadcrumb: { href: "/academics", label: "Academics" },
    title: `${program.credential} ${program.name}`,
    lede: program.summary,
    facts: [
      { label: "Duration", value: program.duration },
      { label: "Credits", value: String(program.credits) },
      { label: "Format", value: program.format },
      { label: "Fees", value: `${money(program.tuition)}${program.tuitionUnit === "year" ? " per year" : ""}` },
      { label: "Cohort", value: program.cohort },
    ],
  })}

  <section class="section">
    <div class="shell split">
      <div class="prose">
        <h2>What the program is</h2>
        ${program.overview.map((paragraph) => `<p>${esc(paragraph)}</p>`).join("")}
        <h2>What you will be able to do</h2>
        <ul>${program.outcomes.map((outcome) => `<li>${esc(outcome)}</li>`).join("")}</ul>
        <h2>Where it leads</h2>
        <ul>${program.careers.map((career) => `<li>${esc(career)}</li>`).join("")}</ul>
      </div>
      <aside class="panel panel--sticky">
        <p class="eyebrow">Apply</p>
        <h2>${esc(program.credential)} ${esc(program.name)}</h2>
        <p>${esc(program.summary)}</p>
        <dl class="panel__facts">
          <div><dt>Applications</dt><dd>${esc(applicationWindowLabel(cycle))}</dd></div>
          <div><dt>Fees</dt><dd>${money(program.tuition)}${program.tuitionUnit === "year" ? " / year" : ""}</dd></div>
          <div><dt>Start</dt><dd>${esc(formatDate(cycle.starts))}</dd></div>
        </dl>
        <p class="form-note">${esc(program.tuitionNote)}</p>
        <a class="button" href="/admissions/apply?program=${esc(program.slug)}">Apply for this program</a>
      </aside>
    </div>
  </section>

  <section class="section section--tint">
    <div class="shell">
      ${sectionHead({
        eyebrow: "Curriculum",
        title: "The full sequence.",
        lede: "Courses are taught in sequence, in studios of no more than eighteen. Every module is assessed by a build and an oral defense.",
      })}
      ${curriculum}
    </div>
  </section>

  ${ctaBand({
    eyebrow: `${program.level} · ${cycle.name}`,
    title: "Questions about fit? Ask before you apply.",
    body: "A member of faculty answers admissions email, not an admissions funnel.",
    href: `mailto:admissions@${ctx.mailDomain}`,
    label: "Email admissions",
  })}`;

  return layout({
    title: `${program.credential} ${program.name}`,
    description: program.summary,
    surface: "public",
    active: "academics",
    ctx,
    body,
  });
}

export function admissions(ctx: UiContext): string {
  const upcoming = intakeTerms();
  const cycle = applicationCycle();
  const body = `
  ${pageHead({
    eyebrow: "Admissions",
    title: "Admission is a conversation, not a filter.",
    lede: "We read every application. There is no fee, no entrance examination and no requirement that your first degree has a particular name. We are looking for evidence that you can do the work and a clear sense of what you want to do with it.",
    facts: [
      { label: "Applications open", value: formatDate(cycle.applicationsOpen) },
      { label: "Priority deadline", value: formatDate(cycle.applicationsPriority) },
      { label: "Final deadline", value: formatDate(cycle.applicationsClose) },
      { label: "Decision", value: "Within three weeks of interview" },
    ],
  })}

  <section class="section">
    <div class="shell">
      ${sectionHead({
        eyebrow: "Process",
        title: "Four steps, in this order.",
        lede: "Each step tells you what happens next, and when. If something is unclear, the admissions office answers email within two working days.",
      })}
      <div class="steps">
        <div class="step">
          <span class="step__number">01</span>
          <h3>Apply online</h3>
          <p>Program, intake, contact details and a statement of up to 4,000 characters. About twenty minutes. No documents are needed at this stage.</p>
        </div>
        <div class="step">
          <span class="step__number">02</span>
          <h3>Have a conversation</h3>
          <p>Thirty minutes with a member of faculty, by video. We will ask what you have built, what you want to build, and what you have read closely.</p>
        </div>
        <div class="step">
          <span class="step__number">03</span>
          <h3>Receive a decision</h3>
          <p>Within three weeks of the conversation. Offers state the program, intake, fee and the date by which you must accept.</p>
        </div>
        <div class="step">
          <span class="step__number">04</span>
          <h3>Enroll and get your account</h3>
          <p>Accept, pay the first installment, and the registrar issues your student number, portal account and <strong>@${esc(ctx.mailDomain)}</strong> address.</p>
        </div>
      </div>
    </div>
  </section>

  <section class="section section--tint" id="requirements">
    <div class="shell split">
      <div class="prose">
        <h2>What we ask for</h2>
        <p>Requirements differ by program, but the principle is the same: show that you can do the work. A transcript is one kind of evidence, not the only one.</p>
        <ul>
          <li><strong>Undergraduate:</strong> completion of secondary education, or equivalent professional experience. Mathematics to the level of a strong high-school course.</li>
          <li><strong>Graduate:</strong> a degree in a technical or quantitative field, or a portfolio and professional record that demonstrates equivalent ability.</li>
          <li><strong>Professional certificate:</strong> no formal prerequisite. You should be working on, or responsible for, automated systems in some capacity.</li>
          <li><strong>English:</strong> teaching and assessment are in English. If English is not your first language, we may ask for evidence of proficiency at interview.</li>
        </ul>
        <h2 id="fees">Fees and aid</h2>
        <table class="table">
          <thead><tr><th>Program</th><th>Credential</th><th class="num">Fee</th><th>Payment</th></tr></thead>
          <tbody>
            ${PROGRAMS.map(
              (program) => `<tr>
                <td><a href="/academics/${esc(program.slug)}">${esc(program.name)}</a></td>
                <td>${esc(program.credential)}</td>
                <td class="num">${money(program.tuition)}${program.tuitionUnit === "year" ? " / yr" : ""}</td>
                <td>${esc(program.tuitionUnit === "year" ? "Per year, in two installments" : "Three installments")}</td>
              </tr>`,
            ).join("")}
          </tbody>
        </table>
        <p class="form-note">Income-based aid covers up to 100% of fees for admitted students. There is no separate aid application: the statement and interview are the application. Employer invoicing is available for the professional certificate.</p>
        <h2>What we do not ask for</h2>
        <ul>
          <li>An application fee.</li>
          <li>Standardized test scores.</li>
          <li>Letters of recommendation. We would rather hear from you.</li>
        </ul>
      </div>
      <aside class="panel panel--sticky">
        <p class="eyebrow">Intakes</p>
        <h2>${esc(cycle.name)}</h2>
        <dl class="panel__facts">
          ${upcoming
            .map(
              (term) => `<div><dt>${esc(term.name)}</dt><dd>${esc(formatDate(term.starts))}</dd></div>`,
            )
            .join("")}
          <div><dt>Applications close (${esc(cycle.name)})</dt><dd>${esc(formatDate(cycle.applicationsClose))}</dd></div>
          <div><dt>Decision</dt><dd>Within 3 weeks</dd></div>
        </dl>
        <a class="button" href="/admissions/apply">Begin an application</a>
        <p class="form-note">Questions? <a href="mailto:admissions@${esc(ctx.mailDomain)}">admissions@${esc(ctx.mailDomain)}</a></p>
      </aside>
    </div>
  </section>

  <section class="section">
    <div class="shell">
      ${sectionHead({
        eyebrow: "Calendar",
        title: "What happens, and when.",
        lede: `The ${cycle.name} cycle, from the day applications open to the first day of teaching.`,
      })}
      ${timelineRows(cycle)}
    </div>
  </section>

  <section class="section section--tint" id="faq">
    <div class="shell split">
      <div>
        ${sectionHead({ eyebrow: "Questions", title: "The ones we are asked most." })}
        <div class="faq">
          ${FAQ.map(
            (item) => `<details>
              <summary>${esc(item.question)}</summary>
              <p>${esc(item.answer)}</p>
            </details>`,
          ).join("")}
        </div>
      </div>
      <aside class="panel panel--sticky">
        <p class="eyebrow">Admissions office</p>
        <h2>Talk to a person.</h2>
        <p>Email is read by the admissions team, not a queue robot. We answer within two working days.</p>
        <dl class="panel__facts">
          <div><dt>Email</dt><dd><a href="mailto:admissions@${esc(ctx.mailDomain)}">admissions@${esc(ctx.mailDomain)}</a></dd></div>
          <div><dt>Registrar</dt><dd><a href="mailto:registrar@${esc(ctx.mailDomain)}">registrar@${esc(ctx.mailDomain)}</a></dd></div>
          <div><dt>Portal</dt><dd><a href="/portal">Student sign-in</a></dd></div>
        </dl>
        <a class="button button--ghost" href="/academics">Compare programs</a>
      </aside>
    </div>
  </section>`;

  return layout({ title: "Admissions", surface: "public", active: "admissions", ctx, body });
}

export function applyForm(
  ctx: UiContext,
  state: { values?: Partial<ApplicationInput>; fields?: Record<string, string>; error?: string } = {},
): string {
  const values = state.values ?? {};
  const fields = state.fields ?? {};
  const openTerms = openApplicationTerms();
  const cycle = applicationCycle();
  const body = `
  ${pageHead({
    eyebrow: "Admissions",
    breadcrumb: { href: "/admissions", label: "Admissions" },
    title: "Begin an application.",
    lede: "Twenty minutes, no fee, no documents. We will read this before we ask you for anything else.",
  })}

  <section class="section">
    <div class="shell form-grid">
      <form method="post" action="/admissions/apply" novalidate>
        ${state.error ? notice("error", state.error) : ""}
        <p class="eyebrow">Your application</p>
        <div class="form-row">
          ${field({ label: "First name", name: "firstName", value: values.firstName, autocomplete: "given-name", required: true, maxlength: 60, error: fields.firstName })}
          ${field({ label: "Family name", name: "lastName", value: values.lastName, autocomplete: "family-name", required: true, maxlength: 60, error: fields.lastName })}
        </div>
        <div class="form-row">
          ${field({ label: "Email", name: "email", type: "email", value: values.email, autocomplete: "email", inputmode: "email", required: true, error: fields.email })}
          ${field({ label: "Country", name: "country", value: values.country, autocomplete: "country-name", required: true, maxlength: 60, error: fields.country })}
        </div>
        <div class="form-row">
          ${selectField({
            label: "Program",
            name: "programSlug",
            value: values.programSlug,
            required: true,
            error: fields.programSlug,
            options: PROGRAMS.map((program) => ({ value: program.slug, label: `${program.credential} ${program.name}` })),
          })}
          ${selectField({
            label: "Intake",
            name: "termId",
            value: values.termId,
            required: true,
            error: fields.termId,
            options: openTerms.length > 0
              ? openTerms.map((term) => ({
                  value: term.id,
                  label: `${term.name} — apply by ${formatDate(term.applicationsClose)}`,
                }))
              : [{ value: "", label: "No intake is accepting applications right now" }],
          })}
        </div>
        ${textareaField({
          label: "What do you want to build?",
          name: "statement",
          value: values.statement,
          error: fields.statement,
          rows: 9,
          hint: "At least 80 characters. Tell us what you have built, what you want to build, and what you have read closely.",
        })}
        ${checkboxField({
          labelHtml: `I have read the <a href="/privacy">privacy notice</a> and agree to the <a href="/terms">terms of use</a>.`,
          name: "consent",
          checked: values.consent === "on",
          error: fields.consent,
        })}
        <button class="button" type="submit">Submit application</button>
        <p class="form-note">Submitting does not create a student account. Accounts and <strong>@${esc(ctx.mailDomain)}</strong> addresses are issued when an offer is accepted.</p>
      </form>

      <aside class="panel panel--sticky">
        <p class="eyebrow">What happens next</p>
        <h2>From here to a decision.</h2>
        <dl class="panel__facts">
          <div><dt>1</dt><dd>We confirm receipt by email.</dd></div>
          <div><dt>2</dt><dd>A member of faculty invites you to a 30-minute conversation.</dd></div>
          <div><dt>3</dt><dd>You receive a decision within three weeks of that conversation.</dd></div>
          <div><dt>4</dt><dd>If you accept, the registrar issues your account and address.</dd></div>
        </dl>
        <p class="form-note">If you would rather ask a question first, write to <a href="mailto:admissions@${esc(ctx.mailDomain)}">admissions@${esc(ctx.mailDomain)}</a>. It does not affect your application.</p>
      </aside>
    </div>
  </section>`;

  return layout({
    title: "Apply",
    description: `Apply to AthenIQ Institute for the ${cycle.name} intake.`,
    surface: "public",
    active: "admissions",
    ctx,
    body,
  });
}

export function applicationReceived(ctx: UiContext, application: Application): string {
  const program = PROGRAMS.find((item) => item.slug === application.programSlug);
  const term = TERMS.find((item) => item.id === application.termId);
  const body = `
  <section class="section">
    <div class="shell split">
      <div class="prose">
        <p class="eyebrow">Application received</p>
        <h1 class="display-md">Thank you, ${esc(application.firstName)}.</h1>
        <p>Your application to <strong>${esc(program?.credential ?? "")} ${esc(program?.name ?? application.programSlug)}</strong> for <strong>${esc(term?.name ?? application.termId)}</strong> is in the admissions queue.</p>
        <div class="detail-grid">
          <div class="detail"><dt>Reference</dt><dd><span class="code">${esc(application.id)}</span></dd></div>
          <div class="detail"><dt>Submitted</dt><dd>${esc(dateLabel(application.submittedAt))}</dd></div>
          <div class="detail"><dt>Program</dt><dd>${esc(program?.name ?? application.programSlug)}</dd></div>
          <div class="detail"><dt>Intake</dt><dd>${esc(term?.name ?? application.termId)}</dd></div>
        </div>
        <h2>What happens now</h2>
        <ul>
          <li>We read the application and confirm receipt at <strong>${esc(application.email)}</strong>.</li>
          <li>A member of faculty will invite you to a thirty-minute conversation. That is the interview; there is no test.</li>
          <li>You will receive a decision within three weeks of the conversation.</li>
          <li>If you accept an offer, the registrar issues your student number, portal account and <strong>@${esc(ctx.mailDomain)}</strong> address.</li>
        </ul>
        <p>Keep your reference. If you need to add something, write to <a href="mailto:admissions@${esc(ctx.mailDomain)}">admissions@${esc(ctx.mailDomain)}</a> and quote it.</p>
      </div>
      <aside class="panel panel--sticky">
        <p class="eyebrow">While you wait</p>
        <h2>Read the program properly.</h2>
        <p>The curriculum, the assessment and the fees are all published. There are no hidden conditions.</p>
        <a class="button button--ghost" href="/academics/${esc(application.programSlug)}">Open the program</a>
        <p class="form-note">Applications are read in the order they arrive. Priority applicants are interviewed first.</p>
      </aside>
    </div>
  </section>`;

  return layout({
    title: "Application received",
    surface: "public",
    active: "admissions",
    ctx,
    body,
  });
}

export function about(ctx: UiContext): string {
  const body = `
  ${pageHead({
    eyebrow: "The Institute",
    title: "A small institution for a field that is not small.",
    lede: "AthenIQ Institute exists to teach people to build, evaluate and govern machine intelligence — and to be accountable for it. We are new, deliberately small, and publish how we work rather than how we would like to be seen.",
  })}

  <section class="section">
    <div class="shell split">
      <div class="prose">
        <h2>Why we exist</h2>
        <p>Most AI education is either a computer science degree with a new module bolted on, or a short course that teaches tooling that will be obsolete before the certificate is framed. Neither produces people who can be responsible for a system.</p>
        <p>We teach three things together: the mathematics that tells you what a model can and cannot claim; the engineering that makes it reproducible and operable; and the governance that makes it accountable to someone. Separating them produces confident people who cannot answer a hard question.</p>
        <p>The Institute is online-first because the people we want to teach are not all in one city. It is small because studios do not scale, and the studio is the method.</p>
        <h2 id="governance">How we are governed</h2>
        <p>Academic decisions belong to the Faculty Board, chaired by the Dean. Admissions decisions are made by faculty who teach the program, not by an admissions office. The registrar holds the student record and issues accounts and awards; the two roles are separate by design.</p>
        <p>The Institute's accounts, assessment outcomes and completion rates are reviewed annually by an external examiner and published in summary. We do not publish a ranking, because we do not participate in one.</p>
        <h2 id="quality">Academic quality and accreditation</h2>
        <p><strong>AthenIQ Institute is a new institution and does not yet hold accreditation from a recognized body.</strong> We are in the process of seeking recognition, and we will publish the body and the outcome here when that process concludes. Until then, we say so plainly rather than implying a status we do not hold.</p>
        <p>What we can state now: every program is externally examinable; every award is signed and independently verifiable; and every assessment is defended orally before at least two members of faculty. Our quality framework is published to students at enrollment.</p>
        <h2>What we will not do</h2>
        <ul>
          <li>Sell access to a credential that has not been earned.</li>
          <li>Use an AI system to decide an admission or award.</li>
          <li>Claim a partnership, an accreditation or an outcome we cannot evidence.</li>
        </ul>
      </div>
      <aside class="panel panel--sticky">
        <p class="eyebrow">At a glance</p>
        <h2>The Institute</h2>
        <dl class="panel__facts">
          <div><dt>Founded</dt><dd>2026</dd></div>
          <div><dt>Programs</dt><dd>Four</dd></div>
          <div><dt>Faculty</dt><dd>Six</dd></div>
          <div><dt>Studios</dt><dd>Maximum 18</dd></div>
          <div><dt>Format</dt><dd>Online-first</dd></div>
          <div><dt>Credentials</dt><dd>Signed, verifiable</dd></div>
        </dl>
        <a class="button" href="/admissions/apply">Begin an application</a>
      </aside>
    </div>
  </section>

  <section class="band band--ink section--tight">
    <div class="shell">
      <div class="quote">
        <blockquote><p>“An institution is not its buildings. It is the standard it refuses to lower.”</p></blockquote>
        ${statCards()}
      </div>
    </div>
  </section>

  <section class="section" id="faculty">
    <div class="shell">
      ${sectionHead({
        eyebrow: "Faculty",
        title: "Six people who teach what they practice.",
        lede: "Every member of faculty teaches, assesses and supervises. There is no separate teaching track and no adjunct pool.",
      })}
      ${facultyCards()}
    </div>
  </section>

  <section class="section section--tint">
    <div class="shell">
      ${sectionHead({
        eyebrow: "Principles",
        title: "The four commitments we organize around.",
        lede: "These are not values on a wall. Each one decides something concrete: cohort size, assessment format, the role of AI, and what a credential means.",
      })}
      ${principleCards()}
    </div>
  </section>

  ${ctaBand({
    eyebrow: "Admissions",
    title: "If this sounds like the place you want to be, apply.",
    href: "/admissions/apply",
    label: "Begin an application",
  })}`;

  return layout({ title: "The Institute", surface: "public", active: "about", ctx, body });
}

export function verify(ctx: UiContext, verifyUrl: string): string {
  const body = `
  ${pageHead({
    eyebrow: "Verification",
    title: "Check an AthenIQ award.",
    lede: "Certificates and degrees issued by the Institute are signed and recorded by an independent signing service. Verification does not require an account here, and it does not reveal anything about the holder beyond the award.",
  })}

  <section class="section">
    <div class="shell split">
      <div class="prose">
        <h2>What you need</h2>
        <p>Every award carries a verification identifier of the form <span class="code">ATH-XXXXXXXX</span>. It appears on the certificate itself and in the holder's academic record. You do not need the holder's date of birth, student number or any other personal data.</p>
        <h2>What verification proves</h2>
        <ul>
          <li>That the award was issued by AthenIQ Institute.</li>
          <li>That the record has not been altered since issuance.</li>
          <li>Whether the award is current or has been revoked.</li>
        </ul>
        <p>Verification proves the award, not the identity of the person presenting it. If you need to bind an award to a person, ask the holder to share the record from their student portal.</p>
        <h2>If you do not have an identifier</h2>
        <p>Write to <a href="mailto:registrar@${esc(ctx.mailDomain)}">registrar@${esc(ctx.mailDomain)}</a> with the holder's name, the award and the approximate date. The registrar will confirm whether a record exists; they will not disclose personal data to a third party without consent.</p>
      </div>
      <aside class="panel panel--sticky">
        <p class="eyebrow">Verify</p>
        <h2>Open the signing service</h2>
        <p>Verification is handled by the Institute's signing service, not by this site. The service checks the signature and the registry entry.</p>
        ${verifyUrl ? `<a class="button" href="${esc(verifyUrl)}">Open verification</a>` : `<p class="form-note">Verification is not connected in this environment. The production site links to the signing service here.</p>`}
        <dl class="panel__facts">
          <div><dt>Identifier</dt><dd><span class="code">ATH-…</span></dd></div>
          <div><dt>Issuer</dt><dd>AthenIQ Institute</dd></div>
          <div><dt>Signature</dt><dd>Signara</dd></div>
        </dl>
      </aside>
    </div>
  </section>`;

  return layout({ title: "Verify a credential", surface: "public", active: "verify", ctx, body });
}

export function notFound(
  ctx: UiContext,
  surface: Surface = "public",
  viewer: Viewer | null = null,
): string {
  const home = surface === "portal" ? "/portal/dashboard" : "/";
  const body = `
  <section class="section">
    <div class="shell">
      <p class="eyebrow">404</p>
      <h1 class="display-sm">That page does not exist.</h1>
      <p class="muted-copy">The link may be old, or the page may have moved. Nothing has been lost — this is a routing error, not a record error.</p>
      <div class="actions">
        <a class="button" href="${home}">${surface === "public" ? "Back to the Institute" : "Back to the dashboard"}</a>
        ${surface === "public" ? `<a class="button button--ghost" href="/academics">Academics</a>` : ""}
      </div>
    </div>
  </section>`;
  return layout({ title: "Not found", surface, viewer, ctx, body, description: "Page not found." });
}

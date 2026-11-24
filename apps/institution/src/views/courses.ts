/**
 * The courses section of the console.
 *
 * It is the one place the Institute's catalog is edited: add a course, correct
 * one, retire one, and see at a glance whether the LMS is actually serving it.
 * The AI studio writes a draft here and nothing reaches the catalog until a
 * registrar accepts it.
 *
 * These are strings, like the rest of the institution: no client framework, no
 * build step, and the form's own values are re-rendered on an error rather than
 * being thrown away.
 */

import type { CatalogCourse, Module, SyncState } from "../catalog.ts";
import { PROGRAMS, TERMS } from "../content.ts";
import type { CourseDraft, DraftResult } from "../ai.ts";
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
  sectionHead,
  selectField,
  statusBadge,
  textareaField,
  type UiContext,
} from "../ui.ts";

function staff(ctx: UiContext) {
  return { name: ctx.demo ? `registrar@${ctx.mailDomain}` : "Staff", role: "registrar" as const };
}

const TERM_OPTIONS = TERMS.map((term) => ({ value: term.id, label: `${term.name} (${term.id})` }));
const PROGRAM_OPTIONS = PROGRAMS.map((program) => ({ slug: program.slug, name: `${program.credential} ${program.name}` }));

function modulesJson(modules: Module[]): string {
  return modules.length > 0 ? JSON.stringify(modules, null, 2) : "";
}

function gradingJson(course: CatalogCourse): string {
  return course.grading.length > 0 ? JSON.stringify(course.grading, null, 2) : "";
}

function programChecks(selected: string[]): string {
  return `<div class="field">
    <span class="field__label">Programs</span>
    <p class="field__hint">A course appears in a program only when it is listed here. Leave all clear for an elective.</p>
    <div class="check-row">
      ${PROGRAM_OPTIONS.map(
        (program) => `<label class="check">
          <input type="checkbox" name="programs" value="${esc(program.slug)}"${selected.includes(program.slug) ? " checked" : ""}>
          <span>${esc(program.name)}</span>
        </label>`,
      ).join("")}
    </div>
  </div>`;
}

function syncBanner(sync: SyncState, ctx: UiContext): string {
  if (!ctx.lmsUrl && !sync.at) {
    return notice(
      "info",
      "No LMS catalog is configured in this environment, so the console cannot say whether a course is live. Set LMS_BASE_URL to atheniq.courses.",
    );
  }
  if (sync.error) {
    return notice("error", `The last LMS sync failed: ${sync.error}${sync.at ? ` Last successful check was ${dateLabel(sync.at)}.` : ""}`);
  }
  if (!sync.at) return notice("info", "The LMS catalog has not been checked yet. Press “Sync with the LMS”.");
  return notice(
    "success",
    `Last checked ${dateLabel(sync.at)}: ${sync.live.length} of ${sync.live.length + sync.missing.length} catalog courses are served by ${ctx.lmsUrl || "the LMS"}.`,
  );
}

/* --------------------------------------------------------------- catalog */

export function index(
  ctx: UiContext,
  courses: CatalogCourse[],
  sync: SyncState,
  state: { notice?: string; error?: string } = {},
): string {
  const published = courses.filter((course) => course.status === "published");
  const live = new Set(sync.live);
  const checked = Boolean(sync.at);

  const body = `
  ${pageHead({
    eyebrow: "Catalog",
    title: "Courses.",
    lede: "The one catalog: the public program pages, the student's registration page and the LMS sync all read these records. Generate a draft with AI, edit it, then publish it — nothing reaches the catalog until you accept it.",
    facts: [
      { label: "Courses", value: String(courses.length) },
      { label: "Published", value: String(published.length) },
      { label: "Served by the LMS", value: checked ? `${sync.live.length}` : "—" },
      { label: "Not on the LMS", value: checked ? `${sync.missing.length}` : "—" },
    ],
  })}

  <section class="section section--tight">
    <div class="shell">
      ${state.error ? notice("error", state.error) : ""}
      ${state.notice ? notice("success", state.notice) : ""}
      ${syncBanner(sync, ctx)}

      <div class="console-actions">
        <a class="button" href="/courses/new">Add a course</a>
        <a class="button button--ghost" href="/courses/generate">Generate with AI</a>
        <form method="post" action="/courses/sync" class="inline-form">
          <button type="submit" class="button button--ghost">Sync with the LMS</button>
        </form>
      </div>

      <div class="metrics">
        ${metric(String(courses.length), "courses in the catalog")}
        ${metric(String(published.length), "published to the site")}
        ${metric(checked ? String(sync.live.length) : "—", "live on atheniq.courses")}
        ${metric(checked ? String(sync.missing.length) : "—", "awaiting LMS import")}
      </div>

      ${
        courses.length > 0
          ? `<div class="table-wrap"><table class="table">
              <thead><tr><th>Course</th><th>Term</th><th class="num">Credits</th><th>Status</th><th>atheniq.courses</th><th></th></tr></thead>
              <tbody>
                ${courses
                  .map(
                    (course) => `<tr>
                      <td><a href="/courses/${esc(course.code)}"><span class="strong">${esc(course.title)}</span></a><span class="table__sub"><span class="mono">${esc(course.code)}</span> · ${esc(course.key)}${course.source === "ai" ? " · AI draft" : ""}</span></td>
                      <td>${esc(course.termId)}</td>
                      <td class="num">${course.credits}</td>
                      <td>${statusBadge(course.status)}</td>
                      <td>${checked ? statusBadge(live.has(course.code) ? "live" : "missing") : `<span class="muted">—</span>`}</td>
                      <td><a class="textlink" href="/courses/${esc(course.code)}">Open</a></td>
                    </tr>`,
                  )
                  .join("")}
              </tbody>
            </table></div>`
          : emptyState("The catalog is empty", "Add a course, or accept an AI draft, and it appears here immediately.", {
              href: "/courses/new",
              label: "Add a course",
            })
      }

      ${
        sync.external.length > 0
          ? `<div class="section-head mt-12">
              <div><p class="eyebrow">Drift</p><h2>Served by the LMS, absent here.</h2></div>
              <div class="section-head__aside"><p>These courses exist at ${esc(ctx.lmsUrl || "the LMS")} and are not in the Institute's catalog. Import one to bring it under management.</p></div>
            </div>
            <div class="table-wrap"><table class="table">
              <thead><tr><th>Course at the LMS</th><th>Runtime key</th><th></th></tr></thead>
              <tbody>
                ${sync.external
                  .map(
                    (course) => `<tr>
                      <td><span class="strong">${esc(course.title)}</span><span class="table__sub"><span class="mono">${esc(course.code)}</span></span></td>
                      <td><span class="mono">${esc(course.key)}</span></td>
                      <td><form method="post" action="/courses/import">
                        <input type="hidden" name="code" value="${esc(course.code)}">
                        <input type="hidden" name="title" value="${esc(course.title)}">
                        <input type="hidden" name="key" value="${esc(course.key)}">
                        <button class="button button--small button--ghost" type="submit">Import</button>
                      </form></td>
                    </tr>`,
                  )
                  .join("")}
              </tbody>
            </table></div>`
          : ""
      }
    </div>
  </section>`;

  return layout({ title: "Courses", surface: "registrar", active: "courses", viewer: staff(ctx), ctx, body });
}

/* ------------------------------------------------------------ course form */

export interface CourseFormState {
  mode: "new" | "edit";
  values: Record<string, string>;
  fields?: Record<string, string>;
  error?: string;
  notices?: string[];
  sync?: SyncState;
}

export function courseValues(course: CatalogCourse): Record<string, string> {
  if (!course) {
    return { status: "draft", credits: "15", seats: "30", weeks: "12", format: "Studio · 12 weeks" };
  }
  return {
    code: course.code,
    title: course.title,
    termId: course.termId,
    credits: String(course.credits),
    instructor: course.instructor,
    format: course.format,
    seats: String(course.seats),
    weeks: String(course.weeks),
    summary: course.summary,
    description: course.description,
    outcomes: course.outcomes.join("\n"),
    prerequisites: course.prerequisites.join("\n"),
    audience: course.audience,
    status: course.status,
    modules: modulesJson(course.modules),
    grading: gradingJson(course),
  };
}

export function courseForm(ctx: UiContext, courses: CatalogCourse[], state: CourseFormState): string {
  const course = state.mode === "edit" ? courseOf(courses, state.values.code ?? "") : undefined;
  const values = state.values;
  const fields = state.fields ?? {};
  const selectedPrograms = course?.programs ?? [];
  const action = state.mode === "edit" ? `/courses/${esc(values.code ?? "")}` : "/courses";
  const title = state.mode === "edit" ? `${values.title ?? "Course"}` : "Add a course.";
  const live = state.sync?.at ? state.sync.live.includes(values.code ?? "") : null;

  const body = `
  ${pageHead({
    eyebrow: state.mode === "edit" ? "Course" : "Catalog",
    breadcrumb: { href: "/courses", label: "Courses" },
    title,
    lede:
      state.mode === "edit"
        ? `${values.code ?? ""} · ${values.termId ?? ""} · the runtime key is derived from the code and term.`
        : "A course record is the catalog entry, the registration rules and the LMS listing in one. Save it as a draft first if the curriculum is not written yet.",
    facts: state.mode === "edit" ? [
      { label: "Code", value: values.code ?? "" },
      { label: "Runtime key", value: course?.key ?? "" },
      { label: "Status", value: values.status ?? "draft" },
      { label: "Updated", value: dateLabel(course?.updatedAt) },
    ] : [],
  })}

  <section class="section">
    <div class="shell split">
      <div>
        ${state.error ? notice("error", state.error) : ""}
        ${(state.notices ?? []).map((item) => notice("success", item)).join("")}
        <form method="post" action="${action}" class="form-grid">
          <div class="form-row">
            ${field({ label: "Course code", name: "code", value: values.code, required: true, error: fields.code, hint: "AI101 — 2–8 letters and 2–4 digits. It is part of the runtime key and cannot be changed later.", maxlength: 16 })}
            ${field({ label: "Title", name: "title", value: values.title, required: true, error: fields.title, maxlength: 160 })}
          </div>
          <div class="form-row">
            ${selectField({ label: "Term", name: "termId", options: TERM_OPTIONS, value: values.termId, required: true, error: fields.termId })}
            ${selectField({
              label: "Status",
              name: "status",
              options: [
                { value: "draft", label: "Draft — hidden from students" },
                { value: "published", label: "Published — open for registration" },
                { value: "archived", label: "Archived — kept, closed" },
              ],
              value: values.status,
              required: true,
            })}
          </div>
          <div class="form-row">
            ${field({ label: "Credits", name: "credits", type: "number", value: values.credits, required: true, error: fields.credits, inputmode: "numeric" })}
            ${field({ label: "Seats", name: "seats", type: "number", value: values.seats, required: true, error: fields.seats, inputmode: "numeric" })}
            ${field({ label: "Weeks", name: "weeks", type: "number", value: values.weeks, required: true, error: fields.weeks, inputmode: "numeric" })}
          </div>
          <div class="form-row">
            ${field({ label: "Instructor of record", name: "instructor", value: values.instructor, required: true, error: fields.instructor, maxlength: 120 })}
            ${field({ label: "Format", name: "format", value: values.format, required: true, error: fields.format, maxlength: 80 })}
          </div>
          ${textareaField({ label: "Summary", name: "summary", value: values.summary, rows: 3, error: fields.summary, hint: "40–800 characters. This is the sentence the public catalog shows." })}
          ${textareaField({ label: "Description", name: "description", value: values.description, rows: 5, hint: "The longer text on the course page. Optional; the summary is used when empty." })}
          ${textareaField({ label: "Outcomes", name: "outcomes", value: values.outcomes, rows: 5, hint: "One per line. What a student can do at the end." })}
          ${textareaField({ label: "Prerequisites", name: "prerequisites", value: values.prerequisites, rows: 3, hint: "One per line." })}
          ${field({ label: "Audience", name: "audience", value: values.audience, maxlength: 300, hint: "Who the course is designed for." })}
          ${programChecks(selectedPrograms)}
          ${textareaField({ label: "Modules", name: "modules", value: values.modules, rows: 10, hint: "JSON written by the AI studio. Edit it here, or regenerate the draft and accept it.", error: fields.modules })}
          ${textareaField({ label: "Grading", name: "grading", value: values.grading, rows: 4, hint: 'JSON, e.g. [{"component":"Practice","weight":40}]. Weights must sum to 100.', error: fields.grading })}
          <div class="actions">
            <button class="button" type="submit">${state.mode === "edit" ? "Save course" : "Add to catalog"}</button>
            <a class="button button--ghost" href="/courses">Cancel</a>
          </div>
        </form>
      </div>

      <aside class="panel panel--sticky">
        <p class="eyebrow">Where this goes</p>
        <h2>One record, three surfaces.</h2>
        <dl class="panel__facts">
          <div><dt>Public site</dt><dd>The program page and the catalog show it while it is published.</dd></div>
          <div><dt>Student portal</dt><dd>Registration lists it, and a seat is held against it.</dd></div>
          <div><dt>LMS</dt><dd>The runtime key is the hand-off. Sync shows whether atheniq.courses serves it.</dd></div>
          <div><dt>AI classroom</dt><dd>OpenMAIC gets the summary and outcomes as the generation requirement.</dd></div>
        </dl>
        ${
          state.mode === "edit" && course
            ? `<div class="panel__divider"></div>
               <p class="eyebrow">AI classroom</p>
               <p class="form-note">${course.classroom ? `Classroom ${esc(course.classroom.classroomId)} generated ${esc(dateLabel(course.classroom.createdAt))}.` : "No classroom has been generated for this course yet."}</p>
               <a class="button button--ghost" href="/courses/${esc(course.code)}/classroom">Open the classroom</a>
               <dl class="panel__facts mt-6">
                 <div><dt>atheniq.courses</dt><dd>${live === null ? "Not checked yet" : live ? "Served by the LMS" : "Not on the LMS"}</dd></div>
                 <div><dt>Runtime key</dt><dd><span class="code">${esc(course.key)}</span></dd></div>
               </dl>
               <div class="panel__divider"></div>
               <p class="eyebrow">Remove</p>
               <p class="form-note">Removing a course deletes it from the Institute catalog. A course with enrollments cannot be removed; archive it instead.</p>
               <form method="post" action="/courses/${esc(course.code)}/delete">
                 <button class="button button--danger" type="submit">Remove ${esc(course.code)}</button>
               </form>`
            : ""
        }
      </aside>
    </div>
  </section>`;

  return layout({
    title: state.mode === "edit" ? `${values.code ?? "Course"}` : "Add a course",
    surface: "registrar",
    active: "courses",
    viewer: staff(ctx),
    ctx,
    body,
  });
}

/* ----------------------------------------------------------- AI generation */

export function generateForm(
  ctx: UiContext,
  state: { error?: string; prompt?: string; termId?: string; code?: string } = {},
): string {
  const body = `
  ${pageHead({
    eyebrow: "AI studio",
    breadcrumb: { href: "/courses", label: "Courses" },
    title: "Generate a course.",
    lede: "Describe the course you want. The estate's model gateway writes a complete draft — outcomes, modules, lessons, assessments and a grading mix — and nothing is saved until you accept it.",
    facts: [
      { label: "Gateway", value: ctx.demo ? "Estate model gateway" : "Configured server-side" },
      { label: "Writes to catalog", value: "Only after acceptance" },
    ],
  })}

  <section class="section">
    <div class="shell split">
      <div>
        ${state.error ? notice("error", state.error) : ""}
        <form method="post" action="/courses/generate" class="form-grid">
          ${textareaField({
            label: "What should the course teach?",
            name: "prompt",
            value: state.prompt,
            rows: 6,
            hint: "A sentence is enough: “a practical course on data engineering for nurses, 4 modules, 15 credits”. Add the audience, the level and the constraint.",
          })}
          <div class="form-row">
            ${selectField({ label: "Term", name: "termId", options: TERM_OPTIONS, value: state.termId ?? "2027A", required: true })}
            ${field({ label: "Preferred code", name: "code", value: state.code, maxlength: 16, hint: "Leave empty and the console picks the next free code." })}
          </div>
          <div class="actions">
            <button class="button" type="submit">Generate draft</button>
            <a class="button button--ghost" href="/courses">Cancel</a>
          </div>
        </form>
      </div>
      <aside class="panel panel--sticky">
        <p class="eyebrow">What the draft contains</p>
        <h2>Structure, not decoration.</h2>
        <ul class="panel__list">
          <li>Outcomes a student can be examined on.</li>
          <li>3–6 modules with lessons, types and minutes.</li>
          <li>An assessment for each module.</li>
          <li>A grading mix that sums to 100%.</li>
          <li>Prerequisites and the intended audience.</li>
        </ul>
        <p class="form-note">If the gateway is unavailable the curriculum rules write the draft instead, and the preview says so. A draft is a draft either way.</p>
      </aside>
    </div>
  </section>`;

  return layout({ title: "Generate a course", surface: "registrar", active: "courses", viewer: staff(ctx), ctx, body });
}

export function generatePreview(
  ctx: UiContext,
  result: DraftResult,
  values: { code: string; termId: string; instructor: string; format: string; seats: string; weeks: string; status: string },
  state: { error?: string } = {},
): string {
  const draft: CourseDraft = result.draft;
  const lessons = draft.modules.reduce((total, module) => total + module.lessons.length, 0);
  const totalWeight = draft.grading.reduce((sum, part) => sum + part.weight, 0);
  const body = `
  ${pageHead({
    eyebrow: "AI draft",
    breadcrumb: { href: "/courses/generate", label: "AI studio" },
    title: draft.title,
    lede: result.note,
    facts: [
      { label: "Engine", value: result.engine === "gateway" ? "Model gateway" : "Curriculum rules" },
      { label: "Modules", value: String(draft.modules.length) },
      { label: "Lessons", value: String(lessons) },
      { label: "Grading", value: `${totalWeight}%` },
    ],
  })}

  <section class="section">
    <div class="shell split">
      <div>
        ${state.error ? notice("error", state.error) : ""}
        <div class="panel mb-8">
          <p class="eyebrow">Summary</p>
          <p class="flush">${esc(draft.summary)}</p>
          <p class="eyebrow mt-6">Description</p>
          <p class="flush">${esc(draft.description)}</p>
          ${
            draft.outcomes.length > 0
              ? `<p class="eyebrow mt-6">Outcomes</p><ul class="panel__list">${draft.outcomes.map((outcome) => `<li>${esc(outcome)}</li>`).join("")}</ul>`
              : ""
          }
        </div>

        <div class="section-head">
          <div><p class="eyebrow">Curriculum</p><h2>${draft.modules.length} modules.</h2></div>
          <div class="section-head__aside"><p>Accepting writes these modules to the course record; they stay editable.</p></div>
        </div>
        <div class="module-cards">
          ${draft.modules
            .map(
              (module, index) => `<div class="module-card">
                <p class="eyebrow">Module ${index + 1}</p>
                <h3>${esc(module.title)}</h3>
                <p>${esc(module.summary)}</p>
                <ul>${module.lessons.map((lesson) => `<li>${esc(lesson.title)} <span class="muted">· ${esc(lesson.type)} · ${lesson.minutes} min</span></li>`).join("")}</ul>
                <p class="form-note">Assessment: ${esc(module.assessment)}</p>
              </div>`,
            )
            .join("")}
        </div>

        <div class="panel mt-8">
          <p class="eyebrow">Grading</p>
          ${draft.grading.map((part) => `<p class="flush">${esc(part.component)} — ${part.weight}%</p>`).join("")}
        </div>
      </div>

      <aside class="panel panel--sticky">
        <p class="eyebrow">Accept</p>
        <h2>Save it to the catalog.</h2>
        <form method="post" action="/courses/generate/accept">
          <textarea name="draft" hidden>${esc(JSON.stringify(draft))}</textarea>
          <input type="hidden" name="engine" value="${esc(result.engine)}">
          <input type="hidden" name="note" value="${esc(result.note)}">
          ${field({ label: "Course code", name: "code", value: values.code, required: true, hint: "Leave empty to take the next free code." })}
          ${selectField({ label: "Term", name: "termId", options: TERM_OPTIONS, value: values.termId, required: true })}
          ${field({ label: "Instructor of record", name: "instructor", value: values.instructor || draft.instructor, required: true })}
          ${field({ label: "Format", name: "format", value: values.format || draft.format, required: true })}
          <div class="form-row">
            ${field({ label: "Seats", name: "seats", type: "number", value: values.seats || "30", required: true })}
            ${field({ label: "Weeks", name: "weeks", type: "number", value: values.weeks || String(draft.weeks), required: true })}
          </div>
          ${selectField({
            label: "Status",
            name: "status",
            options: [
              { value: "draft", label: "Save as a draft" },
              { value: "published", label: "Publish immediately" },
            ],
            value: values.status || "draft",
            required: true,
          })}
          <div class="actions">
            <button class="button" type="submit">Accept into catalog</button>
            <a class="button button--ghost" href="/courses/generate">Try again</a>
          </div>
        </form>
        <p class="form-note">Publishing makes the course visible to students and open for registration. The LMS import is a separate step; the console reports it on the course record.</p>
      </aside>
    </div>
  </section>`;

  return layout({ title: `AI draft: ${draft.title}`, surface: "registrar", active: "courses", viewer: staff(ctx), ctx, body });
}

/* -------------------------------------------------------------- classroom */

export function classroom(
  ctx: UiContext,
  course: CatalogCourse,
  state: { note?: string; error?: string; url?: string | null; configured: boolean },
): string {
  const lessonCount = course.modules.reduce((total, module) => total + module.lessons.length, 0);
  const body = `
  ${pageHead({
    eyebrow: "AI classroom",
    breadcrumb: { href: `/courses/${esc(course.code)}`, label: course.code },
    title: `${course.code} — classroom preview.`,
    lede: `OpenMAIC generates this classroom from the course's own summary and outcomes. It is embedded here with a short-lived instructor token, the same way the classroom appears on atheniq.courses.`,
    facts: [
      { label: "Course", value: course.key },
      { label: "Classroom", value: course.classroom?.classroomId ?? "not generated" },
      { label: "Stage", value: course.classroom?.stageId ?? "—" },
      { label: "Stage lessons", value: lessonCount > 0 ? String(lessonCount) : "—" },
    ],
  })}

  <section class="section section--tight">
    <div class="shell">
      ${state.error ? notice("error", state.error) : ""}
      ${state.note ? notice("info", state.note) : ""}
      ${
        !state.configured
          ? emptyState(
              "The classroom is not connected",
              "Set ATHENIQ_BRIDGE_URL, ATHENIQ_BRIDGE_SERVICE_TOKEN and OPENMAIC_PUBLIC_URL to embed the AI classroom. The rest of the console works without them.",
              { href: `/courses/${course.code}`, label: "Back to the course" },
            )
          : state.url
            ? `<div class="frame">
                 <iframe src="${esc(state.url)}" title="OpenMAIC classroom for ${esc(course.code)}" referrerpolicy="no-referrer" allow="clipboard-write"></iframe>
               </div>
               <div class="console-actions mt-6">
                 <form method="post" action="/courses/${esc(course.code)}/classroom" class="inline-form">
                   <button class="button button--ghost" type="submit">Refresh the classroom token</button>
                 </form>
                 <a class="button button--ghost" href="${esc(state.url)}" target="_blank" rel="noreferrer">Open in a new tab ↗</a>
                 <a class="textlink" href="/courses/${esc(course.code)}">Back to the course</a>
               </div>
               <p class="form-note">The embedding token expires in fifteen minutes. Refreshing this page does not mint another; press “Refresh the classroom token” if the classroom signs you out.</p>`
            : `<p class="eyebrow">Nothing here yet</p>
               <h2>No classroom yet</h2>
               <p>Generate the classroom for this course. OpenMAIC keeps writing it after this page closes, and the same room is reused next time.</p>
               <form method="post" action="/courses/${esc(course.code)}/classroom" class="inline-form">
                 <button class="button" type="submit">Generate the classroom</button>
                 <a class="button button--ghost" href="/courses/${esc(course.code)}">Back to the course</a>
               </form>`
      }
    </div>
  </section>`;

  return layout({ title: `${course.code} classroom`, surface: "registrar", active: "courses", viewer: staff(ctx), ctx, body });
}

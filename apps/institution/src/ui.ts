/**
 * Shared HTML: escaping, the two page chrome surfaces, and the small set of
 * components every view is built from.
 *
 * Everything a visitor supplies is escaped at the point it is interpolated.
 * Nothing in a view is trusted HTML except the strings built here.
 */

import type { Program } from "./content.ts";

const ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ENTITIES[character] ?? character);
}

export function money(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(amount);
}

export function dateLabel(iso: string | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

export type Surface = "public" | "portal" | "registrar";

export interface Viewer {
  name: string;
  role: "student" | "registrar";
}

export interface UiContext {
  publicOrigin: string;
  registrarOrigin: string;
  consoleUrl: string;
  mailDomain: string;
  demo: boolean;
}

export interface LayoutInput {
  title: string;
  description?: string;
  surface: Surface;
  active?: string;
  viewer?: Viewer | null;
  body: string;
  ctx: UiContext;
}

const MARK = `<svg class="mark" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><path d="M16 3 29.5 28H2.5L16 3Z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M16 11.5v9" stroke="currentColor" stroke-width="1.6"/><path d="M11.5 24h9" stroke="currentColor" stroke-width="1.6"/></svg>`;

function brand(href: string, tag: string): string {
  return `<a class="brand" href="${href}" aria-label="AthenIQ Institute — ${esc(tag)}">
    ${MARK}
    <span class="brand__name">AthenIQ<span>Institute</span></span>
  </a>`;
}

function topBar(): string {
  return `<div class="topbar"><div class="shell topbar__inner">
    <p>Fall 2027 applications are open</p>
    <p class="topbar__meta">Priority deadline <strong>January 15, 2027</strong> · <a href="/admissions/apply">Apply</a></p>
  </div></div>`;
}

function navLink(href: string, label: string, activeKey: string | undefined, key: string): string {
  const current = activeKey === key ? ` aria-current="page"` : "";
  return `<a href="${href}"${current}>${label}</a>`;
}

function publicHeader(ctx: UiContext, active: string | undefined): string {
  return `${topBar()}
  <header class="masthead">
    <div class="shell masthead__inner">
      ${brand("/", "Home")}
      <nav class="nav" aria-label="Primary">
        ${navLink("/academics", "Academics", active, "academics")}
        ${navLink("/admissions", "Admissions", active, "admissions")}
        ${navLink("/about", "The Institute", active, "about")}
        ${navLink("/verify", "Verify", active, "verify")}
      </nav>
      <div class="masthead__actions">
        <a class="textlink" href="/portal">Student portal</a>
        <a class="button button--small" href="/admissions/apply">Apply</a>
      </div>
    </div>
  </header>`;
}

function portalHeader(viewer: Viewer | null, active: string | undefined): string {
  if (!viewer) {
    return `<header class="masthead masthead--app">
      <div class="shell masthead__inner">
        ${brand("/portal", "Student portal")}
        <span class="surface-tag">Student portal</span>
        <div class="masthead__actions"><a class="textlink" href="/">Public site</a></div>
      </div>
    </header>`;
  }
  return `<header class="masthead masthead--app">
    <div class="shell masthead__inner">
      ${brand("/portal/dashboard", "Student portal")}
      <span class="surface-tag">Student portal</span>
      <nav class="nav" aria-label="Student portal">
        ${navLink("/portal/dashboard", "Overview", active, "dashboard")}
        ${navLink("/portal/register", "Register", active, "register")}
        ${navLink("/portal/record", "Record", active, "record")}
        ${navLink("/portal/account", "Account", active, "account")}
      </nav>
      <div class="masthead__actions">
        ${viewer ? `<span class="viewer">${esc(viewer.name)}</span>` : ""}
        <form method="post" action="/portal/signout" class="inline-form">
          <button type="submit" class="textlink">Sign out</button>
        </form>
      </div>
    </div>
  </header>`;
}

function registrarHeader(ctx: UiContext, viewer: Viewer | null, active: string | undefined): string {
  if (!viewer) {
    return `<header class="masthead masthead--app masthead--registrar">
      <div class="shell masthead__inner">
        ${brand("/signin", "Registrar")}
        <span class="surface-tag">Registrar</span>
        <div class="masthead__actions"><a class="textlink" href="${esc(ctx.publicOrigin)}">Public site</a></div>
      </div>
    </header>`;
  }
  return `<header class="masthead masthead--app masthead--registrar">
    <div class="shell masthead__inner">
      ${brand("/", "Registrar")}
      <span class="surface-tag">Registrar</span>
      <nav class="nav" aria-label="Registrar">
        ${navLink("/applications", "Applications", active, "applications")}
        ${navLink("/students", "Students", active, "students")}
      </nav>
      <div class="masthead__actions">
        ${ctx.consoleUrl ? `<a class="textlink" href="${esc(ctx.consoleUrl)}">Console ↗</a>` : ""}
        ${viewer ? `<span class="viewer">${esc(viewer.name)}</span>` : ""}
        <form method="post" action="/signout" class="inline-form">
          <button type="submit" class="textlink">Sign out</button>
        </form>
      </div>
    </div>
  </header>`;
}

function publicFooter(ctx: UiContext): string {
  return `<footer class="footer">
    <div class="shell footer__grid">
      <div class="footer__brand">
        <span class="footer__mark">${MARK}</span>
        <p class="footer__name">AthenIQ Institute</p>
        <p class="footer__line">An institute for the age of machine intelligence. Small cohorts, studio teaching, verifiable credentials.</p>
      </div>
      <div>
        <h2 class="footer__head">Study</h2>
        <ul>
          <li><a href="/academics">Programs</a></li>
          <li><a href="/academics/bsc-applied-ai">Undergraduate</a></li>
          <li><a href="/academics/msc-machine-intelligence">Graduate</a></li>
          <li><a href="/academics/pgcert-ai-governance">Professional</a></li>
        </ul>
      </div>
      <div>
        <h2 class="footer__head">Institution</h2>
        <ul>
          <li><a href="/about">About the Institute</a></li>
          <li><a href="/admissions">Admissions</a></li>
          <li><a href="/admissions#fees">Fees and aid</a></li>
          <li><a href="/verify">Verify a credential</a></li>
          <li><a href="/privacy">Privacy notice</a></li>
          <li><a href="/terms">Terms of use</a></li>
          <li><a href="/accessibility">Accessibility</a></li>
        </ul>
      </div>
      <div>
        <h2 class="footer__head">Contact</h2>
        <ul>
          <li><a href="mailto:admissions@${esc(ctx.mailDomain)}">admissions@${esc(ctx.mailDomain)}</a></li>
          <li><a href="mailto:registrar@${esc(ctx.mailDomain)}">registrar@${esc(ctx.mailDomain)}</a></li>
          <li><a href="${esc(ctx.registrarOrigin)}">Registrar sign-in</a></li>
          <li><a href="/portal">Student portal</a></li>
        </ul>
      </div>
    </div>
    <div class="shell footer__base">
      <p>© 2026 AthenIQ Institute. All awards are issued and independently verifiable.</p>
      <p><a href="/about#quality">Academic quality</a> · <a href="/about#governance">Governance</a></p>
    </div>
  </footer>`;
}

function appFooter(ctx: UiContext, surface: Surface): string {
  return `<footer class="footer footer--slim">
    <div class="shell footer__base">
      <p>AthenIQ Institute · ${surface === "registrar" ? "Registrar" : "Student portal"}</p>
      <p>${surface === "registrar" ? `<a href="${esc(ctx.publicOrigin)}">Public site</a>` : `<a href="${esc(ctx.registrarOrigin)}">Registrar</a>`} · <a href="mailto:registrar@${esc(ctx.mailDomain)}">Help</a></p>
    </div>
  </footer>`;
}

export function layout(input: LayoutInput): string {
  const { ctx, surface, viewer } = input;
  const header =
    surface === "portal"
      ? portalHeader(viewer ?? null, input.active)
      : surface === "registrar"
        ? registrarHeader(ctx, viewer ?? null, input.active)
        : publicHeader(ctx, input.active);
  const footer = surface === "public" ? publicFooter(ctx) : appFooter(ctx, surface);
  const title = input.title ? `${input.title} · AthenIQ Institute` : "AthenIQ Institute";
  const description =
    input.description ??
    "AthenIQ Institute: undergraduate, graduate and professional programs in applied artificial intelligence, taught in small studios and assessed by what you can build.";
  const ribbon = ctx.demo
    ? `<div class="demo-ribbon"><div class="shell">Preview environment — application, student and mailbox records are demonstrations.</div></div>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}">
  <meta name="theme-color" content="#12181f">
  ${surface === "public" ? "" : `<meta name="robots" content="noindex, nofollow">`}
  <link rel="icon" href="/assets/mark.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/assets/styles.css">
</head>
<body class="surface-${surface}">
  <a class="skip" href="#main">Skip to content</a>
  ${ribbon}
  ${header}
  <main id="main">
    ${input.body}
  </main>
  ${footer}
  <script src="/assets/app.js" defer></script>
</body>
</html>`;
}

export function notice(kind: "error" | "info" | "success", message: string): string {
  const role = kind === "error" ? "alert" : "status";
  return `<div class="alert alert--${kind}" role="${role}">${esc(message)}</div>`;
}

export function sectionHead(input: {
  eyebrow: string;
  title: string;
  lede?: string;
  action?: { href: string; label: string };
}): string {
  return `<div class="section-head">
    <div>
      <p class="eyebrow">${esc(input.eyebrow)}</p>
      <h2>${esc(input.title)}</h2>
    </div>
    <div class="section-head__aside">
      ${input.lede ? `<p>${esc(input.lede)}</p>` : ""}
      ${input.action ? `<a class="textlink textlink--arrow" href="${esc(input.action.href)}">${esc(input.action.label)} <span aria-hidden="true">→</span></a>` : ""}
    </div>
  </div>`;
}

export function pageHead(input: {
  eyebrow: string;
  title: string;
  lede?: string;
  breadcrumb?: { href: string; label: string };
  facts?: { label: string; value: string }[];
}): string {
  return `<header class="pagehead">
    <div class="shell">
      ${input.breadcrumb ? `<p class="breadcrumb"><a href="${esc(input.breadcrumb.href)}">${esc(input.breadcrumb.label)}</a> <span aria-hidden="true">/</span> ${esc(input.eyebrow)}</p>` : ""}
      <p class="eyebrow">${esc(input.eyebrow)}</p>
      <h1>${esc(input.title)}</h1>
      ${input.lede ? `<p class="pagehead__lede">${esc(input.lede)}</p>` : ""}
      ${
        input.facts && input.facts.length > 0
          ? `<dl class="pagehead__facts">${input.facts
              .map((fact) => `<div><dt>${esc(fact.label)}</dt><dd>${esc(fact.value)}</dd></div>`)
              .join("")}</dl>`
          : ""
      }
    </div>
  </header>`;
}

export function programCard(program: Program, index: number): string {
  return `<a class="program-card" href="/academics/${esc(program.slug)}" data-reveal>
    <span class="program-card__top">
      <span class="mono">${esc(program.level)}</span>
      <span class="program-card__index">${String(index + 1).padStart(2, "0")}</span>
    </span>
    <h3>${esc(program.name)}</h3>
    <p class="program-card__credential">${esc(program.credential)}</p>
    <p>${esc(program.summary)}</p>
    <dl class="program-card__facts">
      <div><dt>Duration</dt><dd>${esc(program.duration)}</dd></div>
      <div><dt>Credits</dt><dd>${program.credits}</dd></div>
      <div><dt>Fees</dt><dd>${money(program.tuition)}${program.tuitionUnit === "year" ? " / year" : ""}</dd></div>
    </dl>
    <span class="program-card__more">Program details <span aria-hidden="true">→</span></span>
  </a>`;
}

export function metric(value: string, label: string): string {
  return `<div class="metric"><span class="metric__value">${esc(value)}</span><span class="metric__label">${esc(label)}</span></div>`;
}

export function emptyState(title: string, body: string, action?: { href: string; label: string }): string {
  return `<div class="empty">
    <p class="eyebrow">Nothing here yet</p>
    <h3>${esc(title)}</h3>
    <p>${esc(body)}</p>
    ${action ? `<a class="button" href="${esc(action.href)}">${esc(action.label)}</a>` : ""}
  </div>`;
}

export function statusBadge(status: string): string {
  const labels: Record<string, string> = {
    submitted: "Submitted",
    under_review: "Under review",
    admitted: "Admitted",
    denied: "Declined",
    registered: "Registered",
    completed: "Completed",
    withdrawn: "Withdrawn",
    reserved: "Reserved",
    active: "Active",
    disabled: "Disabled",
    suspended: "Suspended",
  };
  const tone =
    status === "admitted" || status === "completed" || status === "active"
      ? "good"
      : status === "denied" || status === "suspended" || status === "disabled"
        ? "bad"
        : status === "submitted" || status === "registered" || status === "reserved"
          ? "warn"
          : "neutral";
  return `<span class="badge badge--${tone}">${esc(labels[status] ?? status)}</span>`;
}

export interface FieldInput {
  label: string;
  name: string;
  value?: string;
  type?: string;
  error?: string;
  required?: boolean;
  autocomplete?: string;
  placeholder?: string;
  hint?: string;
  maxlength?: number;
  inputmode?: "text" | "email" | "numeric" | "tel";
}

export function field(input: FieldInput): string {
  const describedBy = input.error ? `${input.name}-error` : input.hint ? `${input.name}-hint` : "";
  return `<div class="field${input.error ? " field--error" : ""}">
    <label for="${esc(input.name)}">${esc(input.label)}${input.required ? ` <span class="req" aria-hidden="true">*</span>` : ""}</label>
    <input
      id="${esc(input.name)}"
      name="${esc(input.name)}"
      type="${esc(input.type ?? "text")}"
      value="${esc(input.value ?? "")}"
      ${input.autocomplete ? `autocomplete="${esc(input.autocomplete)}"` : ""}
      ${input.placeholder ? `placeholder="${esc(input.placeholder)}"` : ""}
      ${input.maxlength ? `maxlength="${input.maxlength}"` : ""}
      ${input.inputmode ? `inputmode="${esc(input.inputmode)}"` : ""}
      ${input.required ? "required" : ""}
      ${input.error ? `aria-invalid="true"` : ""}
      ${describedBy ? `aria-describedby="${esc(describedBy)}"` : ""}
    >
    ${input.hint ? `<p class="field__hint" id="${esc(input.name)}-hint">${esc(input.hint)}</p>` : ""}
    ${input.error ? `<p class="field__error" id="${esc(input.name)}-error">${esc(input.error)}</p>` : ""}
  </div>`;
}

export function selectField(input: {
  label: string;
  name: string;
  options: { value: string; label: string }[];
  value?: string;
  error?: string;
  required?: boolean;
  hint?: string;
}): string {
  return `<div class="field${input.error ? " field--error" : ""}">
    <label for="${esc(input.name)}">${esc(input.label)}${input.required ? ` <span class="req" aria-hidden="true">*</span>` : ""}</label>
    <select id="${esc(input.name)}" name="${esc(input.name)}" ${input.required ? "required" : ""} ${input.error ? `aria-invalid="true"` : ""}>
      <option value="">Choose…</option>
      ${input.options
        .map(
          (option) =>
            `<option value="${esc(option.value)}"${option.value === input.value ? " selected" : ""}>${esc(option.label)}</option>`,
        )
        .join("")}
    </select>
    ${input.hint ? `<p class="field__hint">${esc(input.hint)}</p>` : ""}
    ${input.error ? `<p class="field__error">${esc(input.error)}</p>` : ""}
  </div>`;
}

export function textareaField(input: {
  label: string;
  name: string;
  value?: string;
  error?: string;
  hint?: string;
  rows?: number;
}): string {
  return `<div class="field${input.error ? " field--error" : ""}">
    <label for="${esc(input.name)}">${esc(input.label)} <span class="req" aria-hidden="true">*</span></label>
    <textarea id="${esc(input.name)}" name="${esc(input.name)}" rows="${input.rows ?? 8}" maxlength="4000" aria-describedby="${esc(input.name)}-hint" ${input.error ? `aria-invalid="true"` : ""}>${esc(input.value ?? "")}</textarea>
    <p class="field__hint" id="${esc(input.name)}-hint">${esc(input.hint ?? "")} <span class="counter" data-counter-for="${esc(input.name)}"></span></p>
    ${input.error ? `<p class="field__error">${esc(input.error)}</p>` : ""}
  </div>`;
}

export function checkboxField(input: {
  label: string;
  /** Static copy from this repository only. Never pass visitor input here. */
  labelHtml?: string;
  name: string;
  checked?: boolean;
  error?: string;
}): string {
  return `<div class="field field--check${input.error ? " field--error" : ""}">
    <label class="check">
      <input type="checkbox" id="${esc(input.name)}" name="${esc(input.name)}" value="on"${input.checked ? " checked" : ""}>
      <span>${input.labelHtml ?? esc(input.label)}</span>
    </label>
    ${input.error ? `<p class="field__error">${esc(input.error)}</p>` : ""}
  </div>`;
}

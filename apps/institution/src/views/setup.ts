/**
 * First-run setup form and its completion page.
 *
 * The form posts back to /setup with the one-time token printed at startup.
 * Nothing here writes state: the bootstrap server validates, hashes and stores
 * the values, then renders the completion page.
 */

import { esc } from "../ui.ts";

export interface SetupFormState {
  token: string;
  values?: Record<string, string | undefined>;
  fields?: Record<string, string | undefined>;
  error?: string;
}

const STYLE = `
  :root { color-scheme: light; }
  body { font-family: system-ui, -apple-system, Segoe UI, sans-serif; margin: 0; line-height: 1.5; color: #17181a; background: #f6f5f2; }
  main { max-width: 46rem; margin: 0 auto; padding: 2.5rem 1.25rem 4rem; }
  h1 { font-size: 1.75rem; letter-spacing: -0.02em; margin: 0 0 0.5rem; }
  p { margin: 0 0 1rem; }
  .lede { color: #4b4d52; }
  form { background: #fff; border: 1px solid #dedbd4; border-radius: 6px; padding: 1.5rem; margin-top: 1.5rem; }
  fieldset { border: 0; padding: 0; margin: 0 0 1.5rem; }
  legend { font-weight: 600; padding: 0; margin-bottom: 0.75rem; }
  .field { margin-bottom: 1rem; }
  label { display: block; font-weight: 600; margin-bottom: 0.25rem; }
  .hint { color: #5c5f66; font-size: 0.875rem; margin: 0.25rem 0 0; }
  input, select { width: 100%; box-sizing: border-box; padding: 0.55rem 0.65rem; border: 1px solid #b9b5ad; border-radius: 4px; font: inherit; background: #fff; }
  input:focus, select:focus { outline: 2px solid #2f6fed; outline-offset: 1px; }
  .error-summary { background: #fdecec; border: 1px solid #e3a3a3; color: #7a1414; padding: 0.75rem 1rem; border-radius: 4px; margin-bottom: 1rem; }
  .field-error { color: #7a1414; font-size: 0.875rem; margin: 0.25rem 0 0; }
  button { font: inherit; font-weight: 600; padding: 0.65rem 1.1rem; border: 0; border-radius: 4px; background: #1d4ed8; color: #fff; cursor: pointer; }
  button:hover { background: #1a43b8; }
  .note { color: #4b4d52; font-size: 0.875rem; }
  a { color: #1d4ed8; }
`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>${esc(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
}

function fieldError(state: SetupFormState, name: string): string {
  const message = state.fields?.[name];
  return message ? `<p class="field-error" id="${name}-error">${esc(message)}</p>` : "";
}

function textInput(state: SetupFormState, name: string, label: string, options: {
  type?: string;
  hint?: string;
  placeholder?: string;
  required?: boolean;
  autocomplete?: string;
} = {}): string {
  const value = state.values?.[name] ?? "";
  const invalid = state.fields?.[name] ? ` aria-invalid="true" aria-describedby="${name}-error"` : "";
  return `<div class="field">
    <label for="${name}">${esc(label)}</label>
    <input id="${name}" name="${name}" type="${esc(options.type ?? "text")}" value="${esc(value)}"${options.placeholder ? ` placeholder="${esc(options.placeholder)}"` : ""}${options.autocomplete ? ` autocomplete="${esc(options.autocomplete)}"` : ""}${options.required === false ? "" : " required"}${invalid}>
    ${options.hint ? `<p class="hint">${esc(options.hint)}</p>` : ""}
    ${fieldError(state, name)}
  </div>`;
}

function selectInput(state: SetupFormState, name: string, label: string, choices: Array<{ value: string; label: string }>, fallback: string, hint?: string): string {
  const value = state.values?.[name] ?? fallback;
  return `<div class="field">
    <label for="${name}">${esc(label)}</label>
    <select id="${name}" name="${name}" required>
      ${choices
        .map(
          (choice) =>
            `<option value="${esc(choice.value)}"${choice.value === value ? " selected" : ""}>${esc(choice.label)}</option>`,
        )
        .join("")}
    </select>
    ${hint ? `<p class="hint">${esc(hint)}</p>` : ""}
    ${fieldError(state, name)}
  </div>`;
}

export function setupForm(state: SetupFormState): string {
  const body = `
    <h1>AthenIQ Institute — first-time setup</h1>
    <p class="lede">This page runs once, before the service has a registrar credential. It writes the institutional configuration and then closes itself.</p>
    ${state.error ? `<div class="error-summary" role="alert">${esc(state.error)}</div>` : ""}
    <form method="post" action="/setup" novalidate>
      <input type="hidden" name="token" value="${esc(state.token)}">
      <fieldset>
        <legend>Registrar account</legend>
        ${textInput(state, "registrarEmail", "Registrar email", { type: "email", placeholder: "registrar@atheniq.institute", autocomplete: "username" })}
        ${textInput(state, "registrarPassword", "Registrar password", { type: "password", hint: "At least 12 characters. Stored as a scrypt hash, never in plain text.", autocomplete: "new-password" })}
        ${textInput(state, "confirmPassword", "Confirm password", { type: "password", autocomplete: "new-password" })}
        <p class="note">The session secret is generated here; you do not need to supply one.</p>
      </fieldset>
      <fieldset>
        <legend>Mail</legend>
        ${selectInput(state, "mailProvider", "Mail provider", [
          { value: "local", label: "Local — reserve the address in the registry only" },
          { value: "stalwart", label: "Stalwart — create real mailboxes over JMAP" },
        ], "local", "Stalwart settings are tested before anything is written.")}
        ${textInput(state, "mailDomain", "Mail domain", { placeholder: "atheniq.institute", hint: "Student addresses are issued as first.last@this-domain." })}
        ${textInput(state, "stalwartUrl", "Stalwart URL", { type: "url", placeholder: "https://mail.example.org", hint: "Required when the provider is Stalwart." })}
        ${textInput(state, "stalwartToken", "Stalwart API token", { type: "password", hint: "Required when the provider is Stalwart. Stored in the setup file with mode 0600.", autocomplete: "off" })}
      </fieldset>
      <fieldset>
        <legend>Data</legend>
        ${selectInput(state, "seedDemo", "Demonstration records", [
          { value: "false", label: "No — start with an empty registry" },
          { value: "true", label: "Yes — seed sample applications and a student" },
        ], "false")}
      </fieldset>
      <button type="submit">Write configuration</button>
    </form>`;
  return page("AthenIQ Institute — setup", body);
}

export function setupCompletePage(options: { file: string }): string {
  const body = `
    <h1>Setup complete</h1>
    <p class="lede">The configuration was written to <span class="note">${esc(options.file)}</span> with mode 0600, and this page is now closed.</p>
    <p>Restart the institution service to apply it. On restart the setup page returns 404; configuration is read from the file, with any non-empty environment variable taking precedence.</p>`;
  return page("AthenIQ Institute — setup complete", body);
}

export function setupLockedPage(reason: string): string {
  return page("AthenIQ Institute — setup locked", `<h1>Setup is locked</h1><p class="lede">${esc(reason)}</p>`);
}

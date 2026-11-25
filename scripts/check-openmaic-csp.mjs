#!/usr/bin/env node
/**
 * Guard: the classroom image that is running must answer with the
 * `frame-ancestors` list the estate asked for.
 *
 * OpenMAIC's CSP is baked at build time from `ALLOWED_FRAME_ANCESTORS`
 * (see docker-compose.yml). The image Compose pulls is built by CI from
 * `.env.example`'s value, so it is easy for the two to drift: change
 * `OPENMAIC_FRAME_ANCESTORS` in `.env`, `up`, and the container still serves
 * the old policy. Nothing in the logs says so — the registrar's iframe is just
 * blank, and a blank iframe looks like a cookie or a bridge problem.
 *
 * This asks the running classroom what it actually ships and fails, loudly,
 * when that disagrees with the configuration:
 *
 *   npm run check:openmaic-csp                     # http://127.0.0.1:3000/
 *   node scripts/check-openmaic-csp.mjs --url http://127.0.0.1:3001
 *
 * Exit status: 0 the header matches, 1 it does not, 2 nothing answered.
 *
 * The expected list comes from `--expect`, else `OPENMAIC_FRAME_ANCESTORS` in
 * the environment, else `.env`, else the default Compose resolves. `'self'` is
 * implicit: it is always allowed and never reported as a difference.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Read `KEY=value` out of a dotenv-style file without interpreting it. */
function dotenvValue(file, key) {
  if (!existsSync(file)) return '';
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`).exec(line);
    if (!match) continue;
    const raw = (match[1] ?? '').trim();
    const bare = raw.replace(/^["']|["']$/g, '').trim();
    // A placeholder left in .env.example is not a configured value.
    if (!bare || bare.includes('${')) continue;
    return bare;
  }
  return '';
}

/** The default the openmaic service's build argument falls back to. */
function composeDefault(file) {
  if (!existsSync(file)) return '';
  const text = readFileSync(file, 'utf8');
  const match = /ALLOWED_FRAME_ANCESTORS:\s*\$\{OPENMAIC_FRAME_ANCESTORS:-([^}]*)\}/.exec(text);
  return (match?.[1] ?? '').trim();
}

/** `https://a` and `https://a/` are the same origin; `SELF` is `self`. */
function normalizeOrigin(origin) {
  const trimmed = origin.trim().replace(/\/+$/, '').toLowerCase();
  return trimmed === "'self'" || trimmed === 'self' ? 'self' : trimmed;
}

/** Split a whitespace-separated ancestor list into unique, normalized origins. */
export function parseAncestors(value) {
  return [...new Set(value.split(/\s+/).map(normalizeOrigin).filter(Boolean))];
}

/**
 * Pull the `frame-ancestors` directive out of a Content-Security-Policy header
 * value. Returns null when the header names no frame-ancestors at all, which is
 * its own failure: with no directive, nothing may frame the page.
 */
export function frameAncestorsOf(policy) {
  for (const directive of policy.split(';')) {
    const parts = directive.trim().split(/\s+/);
    if ((parts[0] ?? '').toLowerCase() === 'frame-ancestors') {
      return parts.slice(1).join(' ');
    }
  }
  return null;
}

/** Compare what the image serves with what the estate configured. */
export function compareAncestors(actual, expected) {
  const served = new Set(parseAncestors(actual ?? '').filter((item) => item !== 'self'));
  const wanted = new Set(parseAncestors(expected).filter((item) => item !== 'self'));
  return {
    missing: [...wanted].filter((origin) => !served.has(origin)),
    extra: [...served].filter((origin) => !wanted.has(origin)),
  };
}

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? '' : (process.argv[index + 1] ?? '');
}

const composePath = resolve(argument('compose') || 'docker-compose.yml');
const url = argument('url') || process.env.OPENMAIC_CSP_URL || 'http://127.0.0.1:3000/';
const attempts = Number(argument('attempts') || process.env.OPENMAIC_CSP_ATTEMPTS || 30);

const expected =
  argument('expect') ||
  (process.env.OPENMAIC_FRAME_ANCESTORS ?? '').trim() ||
  dotenvValue(resolve('.env'), 'OPENMAIC_FRAME_ANCESTORS') ||
  composeDefault(composePath);

if (!expected) {
  console.error('check-openmaic-csp: no expected frame ancestors were found.');
  console.error('  Set OPENMAIC_FRAME_ANCESTORS (in .env or the environment), or pass --expect.');
  process.exit(2);
}
if (/\$\{/.test(expected)) {
  console.error(`check-openmaic-csp: OPENMAIC_FRAME_ANCESTORS is unresolved: ${expected}`);
  process.exit(2);
}

let response;
let lastError = '';
for (let attempt = 1; attempt <= attempts; attempt += 1) {
  try {
    response = await fetch(url, { method: 'GET', redirect: 'manual' });
    break;
  } catch (error) {
    lastError = error?.cause?.code || error?.code || error?.message || String(error);
    if (attempt === attempts) break;
    await new Promise((done) => setTimeout(done, 2000));
  }
}

if (!response) {
  console.error(`check-openmaic-csp: nothing answered at ${url} after ${attempts} attempt(s) (${lastError}).`);
  console.error('  Start the classroom first: docker compose up -d openmaic');
  process.exit(2);
}

const policy = response.headers.get('content-security-policy') ?? '';
const frameOptions = response.headers.get('x-frame-options');
const served = frameAncestorsOf(policy);

console.log(`check-openmaic-csp: ${url} answered ${response.status}`);
console.log(`  frame-ancestors: ${served === null ? '(absent)' : served || "(empty)"}`);
console.log(`  expected:        'self' ${parseAncestors(expected).join(' ')}`);

const problems = [];
if (served === null) {
  problems.push('the response carries no frame-ancestors directive, so no host may frame the classroom');
} else {
  const { missing, extra } = compareAncestors(served, expected);
  if (missing.length > 0) {
    problems.push(`the image does not allow ${missing.join(' ')} — the registrar's iframe will be refused (blank frame)`);
  }
  if (extra.length > 0) {
    problems.push(`the image allows ${extra.join(' ')}, which OPENMAIC_FRAME_ANCESTORS does not name`);
  }
}
if (frameOptions) {
  problems.push(`X-Frame-Options: ${frameOptions} is still sent, and it blocks the frame whatever the policy says`);
}

if (problems.length > 0) {
  console.error('');
  console.error('check-openmaic-csp: the running classroom image disagrees with this estate.');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error('');
  console.error('  OpenMAIC bakes this policy at build time, so a restart cannot change it.');
  console.error('  Either pull the image CI built for this value:');
  console.error('    docker compose pull openmaic && docker compose up -d openmaic');
  console.error('  or compile one for it, tagged locally so `up` does not pull over it:');
  console.error(`    OPENMAIC_IMAGE=openmaic:local OPENMAIC_FRAME_ANCESTORS="${expected}" docker compose build openmaic`);
  console.error('    OPENMAIC_IMAGE=openmaic:local docker compose up -d --pull never openmaic');
  console.error('  and then run this check again.');
  process.exit(1);
}

console.log('check-openmaic-csp: the image serves exactly the configured frame ancestors — ok');

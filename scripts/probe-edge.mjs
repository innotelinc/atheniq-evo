#!/usr/bin/env node
/**
 * Ask a public host, path by path, **which gate answered**.
 *
 * The console can be stopped by four different things, and every one of them
 * looks like "the app is broken" from a phone:
 *
 *   • DNS, TLS or a dead origin   — nothing answers
 *   • the NPM edge itself         — its own 404/403 page
 *   • Authentik forward auth      — a 302 to the IdP's authorize endpoint
 *   • the console's own middleware — a 401 "Sign in to use the console."
 *
 * Only after all four does the route answer, with its own status. This script
 * names the one that did, and prints the fix for it, instead of leaving a
 * status code to interpret:
 *
 *   npm run probe:edge
 *   node scripts/probe-edge.mjs --base https://console.atheniq.institute
 *   node scripts/probe-edge.mjs --path /api/mobile/v1/lesson
 *
 * With no `--base`, it probes the host the app itself is built for: the value
 * in `upstream/atheniq-console/mobile/lib/api.ts`, or `EXPO_PUBLIC_API_BASE`
 * from the environment when that is set. It has no host of its own, so it
 * follows the app across cutover; when it cannot find that value it stops
 * instead of guessing a host.
 *
 * A `GET` writes nothing: the webhook has no GET (405), and the mobile routes
 * answer their own 401 without a bearer token.
 *
 * Exit status: 0 every path that must reach the console did, 1 a gate stopped
 * at least one of them, 2 nothing answered at all (so the gate cannot be named).
 *
 * The paths and the reasoning are in docs/monetization.md, "Edge bypass".
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Authentik's outpost redirects here, on the IdP host or its own start URL. */
const AUTHENTIK = /\/application\/o\/authorize\/|\/outpost\.goauthentik\.io\//i;

/** The console middleware's refusal, verbatim (middleware.ts). */
const MIDDLEWARE_JSON = /"error"\s*:\s*"Sign in to use the console\."/i;

/** NPM/openresty's own error page, which never reaches the app. */
const PROXY_PAGE = /<hr>\s*<center>\s*(openresty|nginx)\s*<\/center>/i;

/**
 * The paths the app and RevenueCat call, and the control that must stay gated.
 *
 * `role: "open"` means the request has to reach the console route; `expect` is
 * that route's own status for a GET. `role: "gated"` is the control: it proves
 * the gate is still there, so an "app" result for it means no gate is active.
 */
const PROBES = [
  {
    path: '/api/health/digest',
    role: 'open',
    // 403 is the route's own refusal when DIGEST_TOKEN is unset, which is the
    // normal case on a local console; on the public host it answers 200.
    expect: [200, 403],
    note: 'already exempt at the edge — if this is gated, nothing else can pass',
  },
  {
    path: '/api/mobile/v1',
    role: 'open',
    expect: 200,
    note: "the app's reachability check",
  },
  {
    path: '/api/mobile/v1/auth/login',
    role: 'open',
    expect: 405,
    note: "POST-only sign-in; a 405 proves the path reached the route",
  },
  {
    path: '/api/mobile/v1/me',
    role: 'open',
    expect: 401,
    note: "the app's own 401, not the console's",
  },
  {
    path: '/api/internal/revenuecat/webhook',
    role: 'open',
    expect: 405,
    note: 'POST-only; a 405 proves RevenueCat can reach it',
  },
  {
    path: '/api/credentials',
    role: 'gated',
    note: 'control: a staff page, and it must be stopped by a gate',
  },
];

const FIXES = {
  none:
    'Nothing answered: check DNS, the certificate and that the origin is up. ' +
    'A proxy 502 would have answered, so this is below HTTP.',
  edge:
    'The proxy answered with its own page, so the request never reached the console: ' +
    'check the proxy host forwards this name to the console port.',
  authentik:
    "Authentik forward auth refused it: add the path to the proxy provider's " +
    'Unauthenticated paths (docs/monetization.md, "Edge bypass").',
  'console-middleware':
    'The request reached the console, and its middleware wanted a session: ' +
    'check PUBLIC_PATHS in middleware.ts covers this prefix.',
  app:
    'The path reached the console, but the route answered a different status: ' +
    'check the path is the one this build routes, and that the route is configured.',
};

/**
 * Name the gate from what came back. Order matters: an Authentik redirect is
 * also a 302, and the proxy's page is also a 403/404.
 */
export function classify({ status, location = '', contentType = '', body = '' }) {
  if (!status) return { gate: 'none', evidence: 'no response' };
  if (AUTHENTIK.test(location)) return { gate: 'authentik', evidence: location };
  if (MIDDLEWARE_JSON.test(body)) {
    return { gate: 'console-middleware', evidence: 'the middleware answered 401 JSON' };
  }
  if (status >= 300 && status < 400 && /\/(login|signin)(\?|$)/.test(location)) {
    return { gate: 'console-middleware', evidence: `sign-in redirect to ${location}` };
  }
  if (PROXY_PAGE.test(body)) {
    return { gate: 'edge', evidence: `the proxy answered ${status} itself` };
  }
  return { gate: 'app', evidence: 'the route answered' };
}

/** The mobile client, which is both the caller and the source of the host. */
const MOBILE_CLIENT = fileURLToPath(
  new URL('../upstream/atheniq-console/mobile/lib/api.ts', import.meta.url),
);

/**
 * The base a mobile client source compiles in: `process.env.EXPO_PUBLIC_API_BASE
 * || "https://…"`. Exported so the precedence is testable without a checkout.
 */
export function appBaseFrom(source) {
  const match = /EXPO_PUBLIC_API_BASE\s*\|\|\s*["'`](https?:\/\/[^"'`\s]+)["'`]/.exec(source);
  return match ? match[1].replace(/\/+$/, '') : '';
}

function mobileBase() {
  try {
    return appBaseFrom(readFileSync(MOBILE_CLIENT, 'utf8'));
  } catch {
    return '';
  }
}

function argument(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? '');
}

/** Every `--path` the caller added, in order, after the built-in ones. */
function extraPaths() {
  const found = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === '--path' && process.argv[index + 1]) {
      found.push({ path: process.argv[index + 1], role: 'open' });
    }
  }
  return found;
}

async function request(base, probe) {
  const url = new URL(probe.path, base).toString();
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
      headers: { 'user-agent': 'atheniq-probe-edge/1' },
    });
    const body = await response.text();
    return {
      url,
      status: response.status,
      location: response.headers.get('location') ?? '',
      contentType: response.headers.get('content-type') ?? '',
      body: body.slice(0, 4000),
    };
  } catch (error) {
    const code = error?.cause?.code || error?.code || error?.name || 'error';
    return { url, status: 0, error: code, location: '', contentType: '', body: '' };
  }
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('usage: node scripts/probe-edge.mjs [--base URL] [--path PATH ...]');
  console.log('  --base  origin to probe (default: the app\'s own EXPO_PUBLIC_API_BASE)');
  console.log('  --path  an extra path that must reach the console (repeatable)');
  console.log('');
  console.log('The default comes from EXPO_PUBLIC_API_BASE, or from the mobile client');
  console.log('(upstream/atheniq-console/mobile/lib/api.ts) when that is unset.');
  process.exit(0);
}

/** The app's base first, then the two explicit overrides, then nothing. */
const APP_BASE = mobileBase();
const resolved = (() => {
  const flag = argument('base');
  if (flag) return { base: flag, source: '--base' };
  if (process.env.ATHENIQ_PROBE_BASE) {
    return { base: process.env.ATHENIQ_PROBE_BASE, source: 'ATHENIQ_PROBE_BASE' };
  }
  if (process.env.EXPO_PUBLIC_API_BASE) {
    return { base: process.env.EXPO_PUBLIC_API_BASE, source: 'EXPO_PUBLIC_API_BASE' };
  }
  if (APP_BASE) return { base: APP_BASE, source: 'mobile/lib/api.ts' };
  return { base: '', source: '' };
})();
const base = resolved.base.replace(/\/+$/, '');
if (!base) {
  console.error(
    'probe-edge: cannot tell which host the app uses: no --base, no ' +
      'EXPO_PUBLIC_API_BASE, and upstream/atheniq-console/mobile/lib/api.ts is ' +
      'not here (run scripts/bootstrap.sh). Refusing to guess a host.',
  );
  process.exit(2);
}
if (!/^https?:\/\//i.test(base)) {
  console.error(`probe-edge: --base must be an http(s) origin, not "${base}"`);
  process.exit(2);
}

const probes = [...PROBES, ...extraPaths()];
const width = Math.max(34, ...probes.map((probe) => probe.path.length + 2));

console.log(`probe-edge: ${base}  (${probes.length} paths)`);
console.log(`  base from ${resolved.source}`);
if (resolved.source !== 'mobile/lib/api.ts' && APP_BASE && base !== APP_BASE) {
  console.warn(`  note: the app is built for ${APP_BASE}, so this run checks a different host`);
}
console.log('');

const rows = [];
for (const probe of probes) {
  const response = await request(base, probe);
  const { gate, evidence } = classify(response);
  const expected = Array.isArray(probe.expect) ? probe.expect : probe.expect ? [probe.expect] : [];
  let verdict;
  if (probe.role === 'gated') {
    verdict = gate === 'app' ? 'NO GATE' : 'ok';
  } else if (gate !== 'app') {
    verdict = 'GATED';
  } else if (expected.length > 0 && !expected.includes(response.status)) {
    verdict = 'UNEXPECTED';
  } else {
    verdict = 'ok';
  }
  rows.push({ probe, response, gate, evidence, verdict });
  console.log(
    `  ${probe.path.padEnd(width)} ${String(response.status || '---').padStart(3)}  ` +
      `${gate.padEnd(19)} ${verdict}`,
  );
  if (verdict !== 'ok') {
    console.log(`      ${probe.note ?? ''}`);
    if (expected.length > 0) console.log(`      expected ${expected.join(' or ')} from the route itself`);
    if (response.error) console.log(`      transport: ${response.error}`);
    if (evidence) console.log(`      evidence: ${evidence}`);
  }
}

const answered = rows.filter((row) => !row.response.error);
const gated = rows.filter((row) => row.probe.role === 'open' && row.verdict !== 'ok');
const ungated = rows.filter((row) => row.probe.role === 'gated' && row.verdict === 'NO GATE');

console.log('');
if (answered.length === 0) {
  console.error('probe-edge: nothing answered, so no gate can be named.');
  for (const row of rows) console.error(`  ${row.probe.path}: ${row.response.error}`);
  console.error(`  ${FIXES.none}`);
  process.exit(2);
}

const open = rows.filter((row) => row.probe.role === 'open').length;
if (gated.length > 0) {
  console.error(`probe-edge: ${gated.length} of ${open} paths that must reach the console did not pass.`);
  for (const row of gated) {
    const where = row.gate === 'app' ? `answered ${row.response.status}` : row.gate;
    console.error(`  ${row.probe.path}: ${where} — ${FIXES[row.gate] ?? row.evidence}`);
  }
  console.error('');
  console.error('  The app calls /api/mobile/ for everything it does, so a phone cannot');
  console.error("  sign in while it is gated; RevenueCat's events need the webhook path.");
  console.error('  Both exemptions are listed in docs/monetization.md, "Edge bypass".');
  process.exit(1);
}

if (ungated.length > 0) {
  console.warn(
    `probe-edge: warning — ${ungated.map((row) => row.probe.path).join(', ')} reached the app ` +
      'too, so no gate is active on this host (AUTH_PASSWORD unset?).',
  );
}

console.log(
  `probe-edge: all ${open} paths reached the console and answered as themselves ` +
    `(${probes.length - open} control answered a gate) — ok`,
);

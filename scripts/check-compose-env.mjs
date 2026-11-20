#!/usr/bin/env node
/**
 * Guard: no `${…}` may appear in a file passed to a container through
 * `env_file:`.
 *
 * Docker Compose copies an env_file into the container verbatim — it does not
 * interpolate it. A file containing `ATHENIQ_BRIDGE_JWT_SECRET=${BRIDGE_JWT_SECRET}`
 * therefore gives the app the literal 20-character string `${BRIDGE_JWT_SECRET}`,
 * and the failure surfaces later as "every classroom token is invalid", which
 * looks like a signature bug rather than a deployment one.
 *
 * Values that must be derived belong in `environment:`, where Compose *does*
 * interpolate. This script is what keeps that rule true after today.
 *
 *   node scripts/check-compose-env.mjs [compose-file]
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const composePath = resolve(process.argv[2] ?? 'docker-compose.yml');
const composeDir = dirname(composePath);

if (!existsSync(composePath)) {
  console.error(`check-compose-env: ${composePath} not found`);
  process.exit(2);
}

/** Collect every path named by an `env_file:` key, in both list and inline form. */
function envFilePaths(text) {
  const lines = text.split(/\r?\n/);
  const paths = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const match = /^(\s*)env_file:\s*(.*)$/.exec(line);
    if (!match) continue;

    const indent = (match[1] ?? '').length;
    const inline = (match[2] ?? '').trim();
    if (inline) {
      // env_file: .env   or   env_file: [a, b]
      const bracketed = /^\[(.*)\]$/.exec(inline);
      const raw = bracketed ? (bracketed[1] ?? '').split(',') : [inline];
      for (const entry of raw) {
        const cleaned = entry.trim().replace(/^["']|["']$/g, '');
        if (cleaned) paths.push({ path: cleaned, line: index + 1 });
      }
      continue;
    }

    // List form: following lines that are deeper-indented `- path` entries.
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const item = lines[cursor] ?? '';
      if (!item.trim() || item.trim().startsWith('#')) continue;
      const itemIndent = (item.match(/^\s*/)?.[0] ?? '').length;
      const dash = /^\s*-\s*(.+)$/.exec(item);
      if (!dash || itemIndent <= indent) break;
      const cleaned = (dash[1] ?? '').trim().replace(/^["']|["']$/g, '');
      if (cleaned) paths.push({ path: cleaned, line: cursor + 1 });
    }
  }
  return paths;
}

const compose = readFileSync(composePath, 'utf8');
const entries = envFilePaths(compose);

if (entries.length === 0) {
  console.log('check-compose-env: no env_file entries (nothing to check)');
  process.exit(0);
}

const problems = [];
for (const entry of entries) {
  const target = resolve(composeDir, entry.path);
  if (!existsSync(target)) {
    problems.push(`${entry.path} (compose line ${entry.line}) does not exist`);
    continue;
  }
  const body = readFileSync(target, 'utf8');
  const offenders = body
    .split(/\r?\n/)
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => /\$\{[A-Za-z_][A-Za-z0-9_]*/.test(line));

  if (offenders.length > 0) {
    const names = offenders.map((item) => `${entry.path}:${item.number}`).join(', ');
    problems.push(`${entry.path} is passed via env_file but contains \${…} at ${names}`);
  }
}

if (problems.length > 0) {
  console.error('check-compose-env: env_file must contain literal values only.');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error('  Move derived values into the service\'s `environment:` block, where Compose interpolates.');
  process.exit(1);
}

console.log(`check-compose-env: ${entries.length} env_file entr${entries.length === 1 ? 'y' : 'ies'} literal — ok`);

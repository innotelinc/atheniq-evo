/**
 * `purge:demo` — remove demonstration records from an institution registry.
 *
 * The registry usually lives in the Compose volume `institution-data`, mounted
 * at `/data`, which a script on the host cannot see. This file therefore ships
 * inside the image, so one command reaches the real volume:
 *
 *   npm run purge:demo:compose -- --data-dir /data --dry-run
 *
 * A deployment that keeps the registry on a host path runs the same file in
 * place:
 *
 *   npm run purge:demo -- --data-dir data/institution --dry-run
 *
 * Stop the service before a real run. It holds the registry in memory and writes
 * the whole file back on the next change, which would restore what was removed.
 *
 * A write is always preceded by a timestamped copy of the original file, and a
 * second run with nothing to remove writes nothing.
 */

import {
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { isStoreData, purgeDemo } from "./purge.ts";

/** The service's own fallback when `INSTITUTION_DATA_DIR` is unset. */
const DEFAULT_DATA_DIR = "data/institution";

const USAGE = `Usage: purge-demo [--data-dir <path>] [--dry-run]

Removes applications, students and enrollments marked provenance "demo", plus
the fixed-id records written by older seeds. Student counters are left alone, so
an existing student number is never reused.

  --data-dir <path>  Institution data directory (default: INSTITUTION_DATA_DIR,
                     else ${DEFAULT_DATA_DIR})
  --dry-run          Report what would be removed; write nothing
  --help             Show this message

Stop the institution service before a real run: it keeps the registry in memory
and rewrites the file on the next change.

Compose volume: npm run purge:demo:compose -- --data-dir /data [--dry-run]`;

function fail(message: string): never {
  console.error(`purge-demo: ${message}`);
  process.exit(1);
}

const args = process.argv.slice(2);
let dataDir = process.env.INSTITUTION_DATA_DIR || DEFAULT_DATA_DIR;
let dryRun = false;

for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  if (argument === "--dry-run") {
    dryRun = true;
  } else if (argument === "--data-dir") {
    const value = args[index + 1];
    if (!value) fail("--data-dir needs a path");
    dataDir = value;
    index += 1;
  } else if (argument === "--help" || argument === "-h") {
    console.log(USAGE);
    process.exit(0);
  } else {
    fail(`unknown argument ${argument}\n\n${USAGE}`);
  }
}

const file = join(resolve(dataDir), "registry.json");
if (!existsSync(file)) {
  console.log(`purge-demo: no registry at ${file}; nothing to purge.`);
  process.exit(0);
}

const original = readFileSync(file, "utf8");
let data: unknown;
try {
  data = JSON.parse(original);
} catch (error) {
  fail(`${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
}
if (!isStoreData(data)) {
  fail(`${file} is not a version 1 registry; refusing to rewrite it.`);
}

const result = purgeDemo(data, dryRun);
if (!result.changed) {
  console.log(`purge-demo: nothing to purge in ${file}.`);
  process.exit(0);
}

const summary = `applications: ${result.removed.applications}, students: ${result.removed.students}, enrollments: ${result.removed.enrollments}`;
if (dryRun) {
  console.log(`purge-demo: would remove ${summary}`);
  console.log("Dry run — no files written. Re-run without --dry-run to remove them.");
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
let backup = `${file}.bak-${stamp}`;
for (let suffix = 1; existsSync(backup); suffix += 1) {
  backup = `${file}.bak-${stamp}-${suffix}`;
}
// copyFileSync keeps the registry's 0600 mode on the copy.
copyFileSync(file, backup);

const temporary = `${file}.tmp-${process.pid}`;
writeFileSync(temporary, `${JSON.stringify(result.data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
renameSync(temporary, file);

console.log(`purge-demo: removed ${summary}`);
console.log(`backup: ${backup}`);

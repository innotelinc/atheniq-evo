/**
 * The record of record for AI instruction.
 *
 * The LMS records courseware progress. Signara records signatures. Neither can
 * answer "what did this classroom actually observe, and did the grade reach the
 * book of record?" — so the bridge keeps that ledger, and it is what makes the
 * completion callback idempotent.
 *
 * It is a JSON file with serialised, atomic writes, because one bridge per
 * estate is the intended shape: the ledger is a few thousand small rows, not a
 * database. The interface is deliberately narrow so a Postgres implementation
 * can replace it without touching a route.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  OutcomeObservation,
  StepResult,
} from "./contracts.ts";

export interface ClassroomRecord {
  id: string;
  courseKey: string;
  learnerId: string;
  lmsUsername?: string;
  /** OpenMAIC's generation-run / job id. */
  jobId: string;
  requirement: string;
  createdAt: string;
  createdBy: string;
}

export interface CompletionRecord {
  id: string;
  idempotencyKey: string;
  classroomId: string;
  courseKey: string;
  learnerId: string;
  lmsUsername?: string;
  score?: number;
  maxScore?: number;
  grade: { earned: number; possible: number; percent: number } | null;
  outcomes: OutcomeObservation[];
  /** When the classroom says the work finished. */
  completedAt: string;
  /** When the bridge accepted it. */
  receivedAt: string;
  steps: StepResult[];
  credential: { credentialId: string; verifyId: string; status: string } | null;
  /** `complete` once every configured step is ok or skipped. */
  status: "pending" | "partial" | "complete";
  /** Whether the caller asked for a certificate; never inferred. */
  issueCredential: boolean;
}

export interface CredentialRecord {
  id: string;
  idempotencyKey: string;
  learnerId: string;
  type: string;
  subjectRef: string;
  credentialId: string;
  verifyId: string;
  status: string;
  createdAt: string;
}

export interface EventRecord {
  at: string;
  kind: string;
  subject: string;
  detail: string;
}

export interface LedgerFile {
  version: 1;
  classrooms: ClassroomRecord[];
  completions: CompletionRecord[];
  credentials: CredentialRecord[];
  events: EventRecord[];
}

const EMPTY: LedgerFile = { version: 1, classrooms: [], completions: [], credentials: [], events: [] };
const MAX_EVENTS = 5_000;
/** Bounds how much history one file holds; the transcript is what matters. */
const MAX_COMPLETIONS = 50_000;

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function parseLedger(text: string): LedgerFile {
  const parsed = JSON.parse(text) as Partial<LedgerFile>;
  if (parsed.version !== 1) throw new Error("unsupported ledger version");
  return {
    version: 1,
    classrooms: parsed.classrooms ?? [],
    completions: parsed.completions ?? [],
    credentials: parsed.credentials ?? [],
    events: parsed.events ?? [],
  };
}

export class LedgerStore {
  readonly path: string;
  private data: LedgerFile = structuredClone(EMPTY);
  private loaded = false;
  /** One writer at a time: a read-modify-write must never interleave. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(path: string) {
    this.path = resolve(path);
  }

  async load(): Promise<LedgerFile> {
    if (this.loaded) return this.snapshot();
    try {
      this.data = parseLedger(await readFile(this.path, "utf8"));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
      this.data = structuredClone(EMPTY);
    }
    this.loaded = true;
    return this.snapshot();
  }

  snapshot(): LedgerFile {
    return structuredClone(this.data);
  }

  /**
   * Apply one mutation and persist it.
   *
   * The whole update — read, change, write, rename — runs under one lock, so
   * two completion callbacks for the same learner cannot both see "not yet
   * processed" and both award a certificate.
   */
  async update<T>(mutate: (data: LedgerFile) => T | Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      await this.load();
      const result = await mutate(this.data);
      this.data.completions = this.data.completions.slice(0, MAX_COMPLETIONS);
      this.data.events = this.data.events.slice(-MAX_EVENTS);
      await this.persist();
      return result;
    });
    // Keep the chain alive even when this update rejects.
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
  }

  recordEvent(data: LedgerFile, kind: string, subject: string, detail: string, at = new Date()): void {
    data.events.push({ at: at.toISOString(), kind, subject, detail });
  }
}

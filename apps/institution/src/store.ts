/**
 * The institution registry: applications, students and registrations.
 *
 * One JSON file, written atomically. That is the right shape for one institute
 * on one process, and the wrong shape for a university system with concurrent
 * registrars — docs/institution.md names the migration path (a relational store
 * behind the same Registry methods) rather than pretending otherwise.
 *
 * A corrupt file stops the process. Starting empty would silently re-issue
 * student numbers and mailboxes.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { hashPassword } from "./auth.ts";

export type ApplicationStatus = "submitted" | "under_review" | "admitted" | "denied";
export type MailboxStatus = "reserved" | "active" | "disabled";
export type EnrollmentStatus = "registered" | "completed" | "withdrawn";

export interface Application {
  id: string;
  /** Present only on demonstration records created by the seed. */
  provenance?: "demo";
  firstName: string;
  lastName: string;
  email: string;
  country: string;
  programSlug: string;
  termId: string;
  statement: string;
  status: ApplicationStatus;
  submittedAt: string;
  decidedAt?: string;
  decisionNote?: string;
  studentId?: string;
}

export interface Mailbox {
  address: string;
  status: MailboxStatus;
  provider: string;
  provisionedAt: string;
  activatedAt?: string;
}

export interface Student {
  /** The AthenIQ person id, and therefore the id the bridge and classroom use. */
  id: string;
  /** Present only on demonstration records created by the seed. */
  provenance?: "demo";
  number: string;
  firstName: string;
  lastName: string;
  personalEmail: string;
  schoolEmail: string;
  passwordHash: string;
  mustChangePassword: boolean;
  /** Bumped when the password changes or access is reset; old cookies fail. */
  sessionVersion: number;
  programSlug: string;
  termId: string;
  status: "active" | "suspended";
  createdAt: string;
  mailbox: Mailbox;
  temporaryPasswordIssuedAt?: string;
}

export interface Enrollment {
  id: string;
  /** Present only on demonstration records created by the seed. */
  provenance?: "demo";
  studentId: string;
  courseCode: string;
  termId: string;
  status: EnrollmentStatus;
  registeredAt: string;
  grade?: string;
}

export interface StoreData {
  version: 1;
  applications: Application[];
  students: Student[];
  enrollments: Enrollment[];
  counters: { student: number };
}

export class StoreError extends Error {}

/** Records written before session versions existed are read as version 0. */
function withSessionVersions(data: StoreData): StoreData {
  for (const student of data.students) {
    const record = student as Student & { sessionVersion?: number };
    if (typeof record.sessionVersion !== "number") record.sessionVersion = 0;
  }
  return data;
}

function emptyData(): StoreData {
  return { version: 1, applications: [], students: [], enrollments: [], counters: { student: 0 } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validate(data: unknown, file: string): StoreData {
  if (!isRecord(data) || data.version !== 1) {
    throw new StoreError(`${file} is not a version 1 registry; refusing to start over it`);
  }
  for (const key of ["applications", "students", "enrollments"] as const) {
    if (!Array.isArray(data[key])) throw new StoreError(`${file} has no ${key} array`);
  }
  if (!isRecord(data.counters) || typeof data.counters.student !== "number") {
    throw new StoreError(`${file} has no student counter`);
  }
  return data as unknown as StoreData;
}

export class Store {
  private data: StoreData;
  private readonly file: string;

  private constructor(file: string, data: StoreData) {
    this.file = file;
    this.data = data;
  }

  static open(dataDir: string, options: { seedDemo?: boolean } = {}): Store {
    const directory = resolve(dataDir);
    mkdirSync(directory, { recursive: true });
    const file = join(directory, "registry.json");

    if (existsSync(file)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
      } catch (error) {
        throw new StoreError(`${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
      }
      return new Store(file, withSessionVersions(validate(parsed, file)));
    }

    const store = new Store(file, emptyData());
    if (options.seedDemo) store.seedDemo();
    store.persist();
    return store;
  }

  static inMemory(seedDemo = false): Store {
    const store = new Store("", emptyData());
    if (seedDemo) store.seedDemo();
    return store;
  }

  read(): StoreData {
    return this.data;
  }

  mutate(change: (data: StoreData) => void): void {
    change(this.data);
    this.persist();
  }

  private persist(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp-${process.pid}`;
    writeFileSync(temporary, `${JSON.stringify(this.data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, this.file);
    try {
      chmodSync(this.file, 0o600);
    } catch {
      // Windows does not implement POSIX modes; the file is still user-scoped.
    }
  }

  /**
   * Demonstration records for a preview. This is deliberately explicit: it only
   * runs when INSTITUTION_SEED_DEMO is on, and the UI says so.
   */
  private seedDemo(): void {
    const now = new Date().toISOString();
    const student: Student = {
      id: "lrn_demo0001",
      provenance: "demo",
      number: "ATH-2026-0001",
      firstName: "Nadia",
      lastName: "Rahman",
      personalEmail: "nadia.rahman@example.com",
      schoolEmail: "nadia.rahman@atheniq.institute",
      passwordHash: hashPassword("atheniq-demo"),
      mustChangePassword: false,
      sessionVersion: 0,
      programSlug: "msc-machine-intelligence",
      termId: "2027A",
      status: "active",
      createdAt: now,
      mailbox: {
        address: "nadia.rahman@atheniq.institute",
        status: "reserved",
        provider: "local",
        provisionedAt: now,
      },
    };
    this.data.students.push(student);
    this.data.counters.student = 1;
    this.data.applications.push({
      id: "app_demo0001",
      provenance: "demo",
      firstName: "Jonas",
      lastName: "Weber",
      email: "jonas.weber@example.com",
      country: "Germany",
      programSlug: "bsc-applied-ai",
      termId: "2027A",
      statement:
        "I build scheduling tools for a regional hospital and want the mathematics and engineering to do it properly, not just plausibly.",
      status: "submitted",
      submittedAt: now,
    });
    this.data.enrollments.push(
      {
        id: `enr_${randomBytes(4).toString("hex")}`,
        provenance: "demo",
        studentId: student.id,
        courseCode: "AI201",
        termId: "2028B",
        status: "registered",
        registeredAt: now,
      },
      {
        id: `enr_${randomBytes(4).toString("hex")}`,
        provenance: "demo",
        studentId: student.id,
        courseCode: "AI102",
        termId: "2027A",
        status: "completed",
        registeredAt: now,
        grade: "A",
      },
    );
  }
}

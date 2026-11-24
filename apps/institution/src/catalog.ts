/**
 * The course catalog, as data.
 *
 * Programs and terms stay in `content.ts` because they are institutional
 * decisions that change with review. Courses do not: a registrar adds a section,
 * corrects a credit value or retires an offering, and each of those is a
 * catalog edit rather than a pull request. This file is the one writer of that
 * catalog, and every surface in the institution reads it here — the public
 * program pages, the student's registration page, the registrar's roster and the
 * LMS sync.
 *
 * One JSON file, written atomically. `content.ts` is the seed: the first boot of
 * a new data directory materialises the Institute's published catalog so the
 * service never starts with an empty catalog behind a live public site.
 *
 * Courses are matched to the LMS by course code, not by the full runtime key:
 * the LMS may serve the same subject under another organisation or term, and a
 * code is the one identifier the registrar and the catalog both hold.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { COURSES, PROGRAMS, TERMS, type Course } from "./content.ts";

export type CourseStatus = "draft" | "published" | "archived";
export type CourseSource = "catalog" | "ai";

export interface Lesson {
  title: string;
  /** lecture · reading · practice · discussion · lab · assessment */
  type: string;
  minutes: number;
}

export interface Module {
  title: string;
  summary: string;
  lessons: Lesson[];
  assessment: string;
}

export interface GradingComponent {
  component: string;
  /** Percent. The set must sum to 100 for a published course. */
  weight: number;
}

export interface ClassroomRef {
  classroomId: string;
  stageId: string | null;
  jobId: string;
  createdAt: string;
}

export interface CatalogCourse extends Course {
  status: CourseStatus;
  description: string;
  outcomes: string[];
  audience: string;
  prerequisites: string[];
  modules: Module[];
  grading: GradingComponent[];
  /** Program slugs whose curriculum includes this course. */
  programs: string[];
  source: CourseSource;
  createdAt: string;
  updatedAt: string;
  classroom?: ClassroomRef;
}

export interface CourseInput {
  code: string;
  title: string;
  termId: string;
  credits: number;
  instructor: string;
  format: string;
  seats: number;
  weeks: number;
  summary: string;
  description?: string;
  outcomes?: string[];
  audience?: string;
  prerequisites?: string[];
  modules?: Module[];
  grading?: GradingComponent[];
  programs?: string[];
  status?: CourseStatus;
  source?: CourseSource;
}

export type CatalogResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; fields?: Record<string, string> };

/** What the LMS's public catalog last said. Persisted so a restart does not lie. */
export interface CatalogSync {
  at: string;
  /** Full runtime keys the LMS serves. */
  keys: string[];
  /** Course codes the LMS serves. */
  codes: string[];
  /** Courses the LMS served that the catalog did not hold at the last check. */
  external?: { code: string; title: string; key: string }[];
}

export interface SyncState {
  at: string | null;
  error: string | null;
  /** Catalog codes the LMS serves right now. */
  live: string[];
  /** Catalog codes the LMS does not serve. */
  missing: string[];
  /** Courses the LMS serves that this catalog does not hold. */
  external: { code: string; title: string; key: string }[];
}

interface CatalogData {
  version: 1;
  courses: CatalogCourse[];
  sync: CatalogSync | null;
  syncError?: string;
}

export class CatalogError extends Error {}

const CODE = /^[A-Z]{2,8}[0-9]{2,4}$/;
const MAX_MODULES = 12;
const MAX_LESSONS = 24;

function clean(value: string | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ");
}

function text(value: string | undefined, max: number): string {
  return (value ?? "").trim().slice(0, max);
}

function lines(value: string[] | undefined, limit: number): string[] {
  return (value ?? []).map((item) => clean(item)).filter(Boolean).slice(0, limit);
}

function keyFor(code: string, termId: string): string {
  return `course-v1:AthenIQ+${code}+${termId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function coerceModules(value: unknown): Module[] {
  if (!Array.isArray(value)) return [];
  const modules: Module[] = [];
  for (const item of value.slice(0, MAX_MODULES)) {
    if (!isRecord(item)) continue;
    const title = text(typeof item.title === "string" ? item.title : "", 160);
    if (!title) continue;
    const lessons: Lesson[] = [];
    if (Array.isArray(item.lessons)) {
      for (const lesson of item.lessons.slice(0, MAX_LESSONS)) {
        if (!isRecord(lesson)) continue;
        const lessonTitle = text(typeof lesson.title === "string" ? lesson.title : "", 160);
        if (!lessonTitle) continue;
        const minutes = Number(lesson.minutes);
        lessons.push({
          title: lessonTitle,
          type: text(typeof lesson.type === "string" ? lesson.type : "reading", 40) || "reading",
          minutes: Number.isFinite(minutes) ? Math.min(600, Math.max(1, Math.round(minutes))) : 30,
        });
      }
    }
    modules.push({
      title,
      summary: text(typeof item.summary === "string" ? item.summary : "", 600),
      lessons,
      assessment: text(typeof item.assessment === "string" ? item.assessment : "", 300),
    });
  }
  return modules;
}

export function coerceGrading(value: unknown): GradingComponent[] {
  if (!Array.isArray(value)) return [];
  const parts: GradingComponent[] = [];
  for (const item of value.slice(0, 8)) {
    if (!isRecord(item)) continue;
    const component = text(typeof item.component === "string" ? item.component : "", 60);
    const weight = Number(item.weight);
    if (!component) continue;
    if (!Number.isFinite(weight) || weight <= 0 || weight > 100) continue;
    parts.push({ component, weight: Math.round(weight) });
  }
  return parts;
}

function seed(): CatalogCourse[] {
  const now = new Date().toISOString();
  return COURSES.map((course) => ({
    ...course,
    status: "published" as const,
    description: course.summary,
    outcomes: [],
    audience: "",
    prerequisites: [],
    modules: [],
    grading: [],
    programs: PROGRAMS.filter((program) =>
      program.curriculum.some((block) => block.courses.includes(course.code)),
    ).map((program) => program.slug),
    source: "catalog" as const,
    createdAt: now,
    updatedAt: now,
  }));
}

function validateData(data: unknown, file: string): CatalogData {
  if (!isRecord(data) || data.version !== 1) {
    throw new CatalogError(`${file} is not a version 1 catalog; refusing to start over it`);
  }
  if (!Array.isArray(data.courses)) throw new CatalogError(`${file} has no courses array`);
  return data as unknown as CatalogData;
}

export class Catalog {
  private data: CatalogData;
  private readonly file: string;

  private constructor(file: string, data: CatalogData) {
    this.file = file;
    this.data = data;
  }

  static open(dataDir: string): Catalog {
    const directory = resolve(dataDir);
    mkdirSync(directory, { recursive: true });
    const file = join(directory, "catalog.json");

    if (existsSync(file)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
      } catch (error) {
        throw new CatalogError(
          `${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return new Catalog(file, validateData(parsed, file));
    }

    const catalog = new Catalog(file, { version: 1, courses: seed(), sync: null });
    catalog.persist();
    return catalog;
  }

  /** A catalog that is never written. For tests and the demo seed. */
  static inMemory(courses: CatalogCourse[] = seed()): Catalog {
    return new Catalog("", { version: 1, courses, sync: null });
  }

  all(): CatalogCourse[] {
    return [...this.data.courses].sort(
      (a, b) => a.termId.localeCompare(b.termId) || a.code.localeCompare(b.code),
    );
  }

  published(): CatalogCourse[] {
    return this.all().filter((course) => course.status === "published");
  }

  byCode(code: string): CatalogCourse | undefined {
    const normalized = code.trim().toUpperCase();
    return this.data.courses.find((course) => course.code === normalized);
  }

  byTerm(termId: string): CatalogCourse[] {
    return this.all().filter((course) => course.termId === termId);
  }

  programsFor(code: string): string[] {
    return this.byCode(code)?.programs ?? [];
  }

  create(input: CourseInput, now: Date = new Date()): CatalogResult<CatalogCourse> {
    const fields: Record<string, string> = {};
    const code = clean(input.code).toUpperCase();
    const title = clean(input.title);
    const termId = clean(input.termId);

    if (!CODE.test(code)) fields.code = "Course codes look like AI101 — 2–8 letters followed by 2–4 digits.";
    if (title.length < 4 || title.length > 160) fields.title = "Give the course a title of 4–160 characters.";
    if (!TERMS.some((term) => term.id === termId)) fields.termId = "Choose a term from the Institute calendar.";
    if (!Number.isFinite(input.credits) || input.credits < 1 || input.credits > 60) {
      fields.credits = "Credits are a whole number between 1 and 60.";
    }
    if (!Number.isFinite(input.seats) || input.seats < 1 || input.seats > 500) {
      fields.seats = "Seats are a whole number between 1 and 500.";
    }
    if (!Number.isFinite(input.weeks) || input.weeks < 1 || input.weeks > 52) {
      fields.weeks = "Weeks are a whole number between 1 and 52.";
    }
    const summary = clean(input.summary);
    if (summary.length < 40 || summary.length > 800) {
      fields.summary = "Write a summary of 40–800 characters; it is what the public catalog shows.";
    }
    if (!clean(input.instructor)) fields.instructor = "Name the instructor of record.";
    if (!clean(input.format)) fields.format = "Describe the format, e.g. “Studio · 12 weeks”.";
    if (input.status === "published" && coerceGrading(input.grading).length > 0) {
      const total = coerceGrading(input.grading).reduce((sum, part) => sum + part.weight, 0);
      if (total !== 100) fields.grading = `Grading weights must sum to 100%; they sum to ${total}%.`;
    }

    if (Object.keys(fields).length > 0) {
      return { ok: false, error: "Please correct the highlighted fields.", fields };
    }
    if (this.data.courses.some((course) => course.code === code)) {
      return {
        ok: false,
        error: `${code} already exists. Edit that course, or remove it before adding a new one.`,
        fields: { code: "This code is taken." },
      };
    }

    const timestamp = now.toISOString();
    const course: CatalogCourse = {
      code,
      key: keyFor(code, termId),
      title,
      credits: Math.round(input.credits),
      termId,
      instructor: clean(input.instructor),
      format: clean(input.format),
      summary,
      seats: Math.round(input.seats),
      weeks: Math.round(input.weeks),
      status: input.status ?? "draft",
      description: text(input.description, 4_000) || summary,
      outcomes: lines(input.outcomes, 12),
      audience: text(input.audience, 300),
      prerequisites: lines(input.prerequisites, 8),
      modules: coerceModules(input.modules),
      grading: coerceGrading(input.grading),
      programs: lines(input.programs, 8).filter((slug) => PROGRAMS.some((program) => program.slug === slug)),
      source: input.source ?? "catalog",
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    this.data.courses.push(course);
    this.persist();
    return { ok: true, value: course };
  }

  update(code: string, input: CourseInput, now: Date = new Date()): CatalogResult<CatalogCourse> {
    const existing = this.byCode(code);
    if (!existing) return { ok: false, error: "No such course." };

    // The code is the LMS identity; it is changed by removing and re-adding, not
    // by an edit that would silently orphan enrollments and classroom records.
    const checked = this.validateUpdate(input);
    if (!checked.ok) return checked;

    const timestamp = now.toISOString();
    const updated: CatalogCourse = {
      ...existing,
      title: clean(input.title),
      credits: Math.round(input.credits),
      termId: clean(input.termId),
      key: keyFor(existing.code, clean(input.termId)),
      instructor: clean(input.instructor),
      format: clean(input.format),
      summary: clean(input.summary),
      seats: Math.round(input.seats),
      weeks: Math.round(input.weeks),
      status: input.status ?? existing.status,
      description: text(input.description, 4_000) || clean(input.summary),
      outcomes: lines(input.outcomes, 12),
      audience: text(input.audience, 300),
      prerequisites: lines(input.prerequisites, 8),
      modules: coerceModules(input.modules),
      grading: coerceGrading(input.grading),
      programs: lines(input.programs, 8).filter((slug) =>
        PROGRAMS.some((program) => program.slug === slug),
      ),
      updatedAt: timestamp,
    };
    this.data.courses = this.data.courses.map((course) =>
      course.code === existing.code ? updated : course,
    );
    this.persist();
    return { ok: true, value: updated };
  }

  private validateUpdate(input: CourseInput): CatalogResult<true> {
    const fields: Record<string, string> = {};
    if (clean(input.title).length < 4 || clean(input.title).length > 160) {
      fields.title = "Give the course a title of 4–160 characters.";
    }
    if (!TERMS.some((term) => term.id === clean(input.termId))) {
      fields.termId = "Choose a term from the Institute calendar.";
    }
    if (!Number.isFinite(input.credits) || input.credits < 1 || input.credits > 60) {
      fields.credits = "Credits are a whole number between 1 and 60.";
    }
    if (!Number.isFinite(input.seats) || input.seats < 1 || input.seats > 500) {
      fields.seats = "Seats are a whole number between 1 and 500.";
    }
    if (!Number.isFinite(input.weeks) || input.weeks < 1 || input.weeks > 52) {
      fields.weeks = "Weeks are a whole number between 1 and 52.";
    }
    if (clean(input.summary).length < 40 || clean(input.summary).length > 800) {
      fields.summary = "Write a summary of 40–800 characters; it is what the public catalog shows.";
    }
    if (!clean(input.instructor)) fields.instructor = "Name the instructor of record.";
    if (!clean(input.format)) fields.format = "Describe the format, e.g. “Studio · 12 weeks”.";
    const grading = coerceGrading(input.grading);
    if (grading.length > 0 && grading.reduce((sum, part) => sum + part.weight, 0) !== 100) {
      fields.grading = "Grading weights must sum to 100%.";
    }
    if (Object.keys(fields).length > 0) {
      return { ok: false, error: "Please correct the highlighted fields.", fields };
    }
    return { ok: true, value: true };
  }

  /** Delete a course from the Institute catalog. Enrollments are the caller's guard. */
  remove(code: string): CatalogResult<CatalogCourse> {
    const existing = this.byCode(code);
    if (!existing) return { ok: false, error: "No such course." };
    this.data.courses = this.data.courses.filter((course) => course.code !== existing.code);
    this.persist();
    return { ok: true, value: existing };
  }

  setStatus(code: string, status: CourseStatus, now: Date = new Date()): CatalogResult<CatalogCourse> {
    const existing = this.byCode(code);
    if (!existing) return { ok: false, error: "No such course." };
    const updated: CatalogCourse = { ...existing, status, updatedAt: now.toISOString() };
    this.data.courses = this.data.courses.map((course) =>
      course.code === existing.code ? updated : course,
    );
    this.persist();
    return { ok: true, value: updated };
  }

  setClassroom(code: string, classroom: ClassroomRef): CatalogResult<CatalogCourse> {
    const existing = this.byCode(code);
    if (!existing) return { ok: false, error: "No such course." };
    const updated: CatalogCourse = { ...existing, classroom };
    this.data.courses = this.data.courses.map((course) =>
      course.code === existing.code ? updated : course,
    );
    this.persist();
    return { ok: true, value: updated };
  }

  recordSync(sync: CatalogSync, error: string | null): void {
    this.data.sync = sync;
    this.data.syncError = error ?? undefined;
    this.persist();
  }

  /** A failed check keeps the last successful picture and records why it is stale. */
  recordSyncError(error: string): void {
    this.data.syncError = error;
    this.persist();
  }

  syncState(): SyncState {
    const sync = this.data.sync;
    const codes = this.all().map((course) => course.code);
    const liveSet = new Set(sync?.codes ?? []);
    const knownSet = new Set(codes);
    return {
      at: sync?.at ?? null,
      error: this.data.syncError ?? null,
      live: codes.filter((code) => liveSet.has(code)),
      missing: codes.filter((code) => !liveSet.has(code)),
      external: (sync?.external ?? []).filter((course) => !knownSet.has(course.code)),
    };
  }

  isLive(code: string): boolean {
    return (this.data.sync?.codes ?? []).includes(code.trim().toUpperCase());
  }

  summary(): { courses: number; published: number; draft: number; live: number } {
    const all = this.all();
    return {
      courses: all.length,
      published: all.filter((course) => course.status === "published").length,
      draft: all.filter((course) => course.status === "draft").length,
      live: all.filter((course) => this.isLive(course.code)).length,
    };
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
}

/** A course's term, for views that only hold a code. */
export function termOf(termId: string) {
  return TERMS.find((term) => term.id === termId);
}

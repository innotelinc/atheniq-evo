/**
 * The institution's business rules, separate from HTTP so they can be tested
 * without a browser and reused by a future admissions API.
 *
 * The lifecycle is deliberately narrow:
 *
 *   application ──admit──► student account + student number + @domain mailbox
 *   student ──register──► enrollment (seats checked, duplicates refused)
 *   student ──complete──► credits (recorded by the registrar / LMS sync)
 *
 * Issuing an account is the only place a password is minted, and the plaintext
 * is returned exactly once — to the registrar who admitted the applicant.
 */

import { randomBytes } from "node:crypto";
import { hashPassword, temporaryPassword, verifyPassword } from "./auth.ts";
import type { InstitutionConfig } from "./config.ts";
import { COURSES, PROGRAMS, TERMS, courseByCode, programBySlug, termById } from "./content.ts";
import type { Store, Application, Enrollment, Student } from "./store.ts";

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; fields?: Record<string, string> };

export interface RegistrySummary {
  applications: number;
  awaitingDecision: number;
  students: number;
  registrations: number;
  mailboxesReserved: number;
  programs: number;
  courses: number;
  terms: number;
}

export interface ApplicationInput {
  firstName: string;
  lastName: string;
  email: string;
  country: string;
  programSlug: string;
  termId: string;
  statement: string;
  consent: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function clean(value: string | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ");
}

function id(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}

/** A mailbox local part: ASCII, lower-case, dots between names. */
function localPart(firstName: string, lastName: string): string {
  const ascii = (value: string) =>
    value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "");
  const first = ascii(firstName) || "student";
  const last = ascii(lastName) || "atheniq";
  return `${first}.${last}`;
}

export class Registry {
  private readonly store: Store;
  private readonly config: InstitutionConfig;

  constructor(store: Store, config: InstitutionConfig) {
    this.store = store;
    this.config = config;
  }

  applications(): Application[] {
    return [...this.store.read().applications].sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
  }

  application(idToFind: string): Application | undefined {
    return this.store.read().applications.find((item) => item.id === idToFind);
  }

  createApplication(input: ApplicationInput, now: Date = new Date()): Result<Application> {
    const firstName = clean(input.firstName);
    const lastName = clean(input.lastName);
    const email = clean(input.email).toLowerCase();
    const country = clean(input.country);
    const statement = (input.statement ?? "").trim();
    const fields: Record<string, string> = {};

    if (firstName.length < 1 || firstName.length > 60) fields.firstName = "Enter your first name.";
    if (lastName.length < 1 || lastName.length > 60) fields.lastName = "Enter your family name.";
    if (!EMAIL.test(email) || email.length > 200) fields.email = "Enter an email address we can reach you at.";
    if (country.length < 2 || country.length > 60) fields.country = "Enter the country you are applying from.";
    if (statement.length < 80) fields.statement = "Write at least 80 characters — we read these.";
    if (statement.length > 4_000) fields.statement = "Keep your statement under 4,000 characters.";
    if (input.consent !== "on") fields.consent = "Please confirm you have read how we handle your application.";

    const program = programBySlug(input.programSlug);
    if (!program) fields.programSlug = "Choose a program.";
    const term = termById(input.termId);
    if (!term || !term.intake) fields.termId = "Choose an intake that is accepting applications.";

    if (Object.keys(fields).length > 0) {
      return { ok: false, error: "Please correct the highlighted fields.", fields };
    }

    const duplicate = this.store
      .read()
      .applications.find(
        (item) =>
          item.email === email &&
          item.programSlug === input.programSlug &&
          item.termId === input.termId &&
          item.status !== "denied",
      );
    if (duplicate) {
      return {
        ok: false,
        error: `We already have an application from ${email} for this program and intake (${duplicate.id}).`,
        fields,
      };
    }

    const application: Application = {
      id: id("app"),
      firstName,
      lastName,
      email,
      country,
      programSlug: input.programSlug,
      termId: input.termId,
      statement,
      status: "submitted",
      submittedAt: now.toISOString(),
    };
    this.store.mutate((data) => {
      data.applications.push(application);
    });
    return { ok: true, value: application };
  }

  /**
   * Admit or decline an application. Admission is where a person becomes a
   * student: the account, number and mailbox are created in the same write, so
   * there is no state in which an admitted applicant has no account.
   */
  decide(
    applicationId: string,
    decision: "admit" | "deny",
    note: string,
    now: Date = new Date(),
  ): Result<{ application: Application; student?: Student; tempPassword?: string }> {
    const application = this.application(applicationId);
    if (!application) return { ok: false, error: "No such application." };
    if (application.status === "admitted") return { ok: false, error: "This application has already been admitted." };

    if (decision === "deny") {
      this.store.mutate((data) => {
        const target = data.applications.find((item) => item.id === applicationId);
        if (!target) return;
        target.status = "denied";
        target.decidedAt = now.toISOString();
        target.decisionNote = note.trim().slice(0, 500);
      });
      return { ok: true, value: { application: { ...application, status: "denied" } } };
    }

    const issued = this.issueAccount(application, now);
    this.store.mutate((data) => {
      const target = data.applications.find((item) => item.id === applicationId);
      if (!target) return;
      target.status = "admitted";
      target.decidedAt = now.toISOString();
      target.decisionNote = note.trim().slice(0, 500);
      target.studentId = issued.student.id;
    });
    return {
      ok: true,
      value: {
        application: { ...application, status: "admitted", studentId: issued.student.id },
        student: issued.student,
        tempPassword: issued.tempPassword,
      },
    };
  }

  private issueAccount(application: Application, now: Date) {
    const data = this.store.read();
    let local = localPart(application.firstName, application.lastName);
    let address = `${local}@${this.config.mailDomain}`;
    let suffix = 2;
    while (data.students.some((student) => student.schoolEmail === address)) {
      address = `${local}${suffix}@${this.config.mailDomain}`;
      suffix += 1;
    }

    const year = now.getUTCFullYear();
    data.counters.student += 1;
    const number = `ATH-${year}-${String(data.counters.student).padStart(4, "0")}`;
    const tempPassword = temporaryPassword();

    const student = {
      id: id("lrn"),
      number,
      firstName: application.firstName,
      lastName: application.lastName,
      personalEmail: application.email,
      schoolEmail: address,
      passwordHash: hashPassword(tempPassword),
      mustChangePassword: true,
      programSlug: application.programSlug,
      termId: application.termId,
      status: "active" as const,
      createdAt: now.toISOString(),
      mailbox: {
        address,
        status: "reserved" as const,
        provider: this.config.mailProvider,
        provisionedAt: now.toISOString(),
      },
      temporaryPasswordIssuedAt: now.toISOString(),
    };
    this.store.mutate((store) => {
      store.students.push(student);
    });
    return { student, tempPassword };
  }

  /** Record that the provider created (or re-created) the mailbox. */
  activateMailbox(studentId: string, now: Date = new Date()): Student | undefined {
    this.store.mutate((data) => {
      const target = data.students.find((item) => item.id === studentId);
      if (!target) return;
      if (target.mailbox.status !== "active") {
        target.mailbox.status = "active";
        target.mailbox.activatedAt = now.toISOString();
      }
    });
    return this.student(studentId);
  }

  students(): Student[] {
    return [...this.store.read().students].sort((a, b) => a.number.localeCompare(b.number));
  }

  student(studentId: string): Student | undefined {
    return this.store.read().students.find((item) => item.id === studentId);
  }

  studentByEmail(email: string): Student | undefined {
    const normalized = email.trim().toLowerCase();
    return this.store.read().students.find((item) => item.schoolEmail === normalized);
  }

  signIn(email: string, password: string): Result<Student> {
    const student = this.studentByEmail(email);
    // One message for both failures: an unknown address must not be
    // distinguishable from a wrong password.
    if (!student || !verifyPassword(password, student.passwordHash)) {
      return { ok: false, error: "That email address and password do not match a student account." };
    }
    if (student.status !== "active") {
      return { ok: false, error: "This account is suspended. Contact the registrar." };
    }
    return { ok: true, value: student };
  }

  enrollmentsFor(studentId: string): Enrollment[] {
    return this.store
      .read()
      .enrollments.filter((item) => item.studentId === studentId)
      .sort((a, b) => b.registeredAt.localeCompare(a.registeredAt));
  }

  seatsTaken(courseCode: string): number {
    return this.store
      .read()
      .enrollments.filter((item) => item.courseCode === courseCode && item.status === "registered").length;
  }

  creditsEarned(studentId: string): number {
    return this.enrollmentsFor(studentId)
      .filter((item) => item.status === "completed")
      .reduce((total, item) => total + (courseByCode(item.courseCode)?.credits ?? 0), 0);
  }

  register(studentId: string, courseCode: string, now: Date = new Date()): Result<Enrollment> {
    const student = this.student(studentId);
    if (!student) return { ok: false, error: "No such student." };
    if (student.status !== "active") return { ok: false, error: "This account is suspended." };

    const course = courseByCode(courseCode.trim().toUpperCase());
    if (!course) return { ok: false, error: "No such course." };

    const term = termById(course.termId);
    if (!term || term.registration === "closed") {
      return { ok: false, error: "Registration for this course has closed." };
    }
    if (term.registration === "waitlist") {
      return { ok: false, error: "This term is on a waitlist. Contact the registrar to be added." };
    }

    const existing = this.store
      .read()
      .enrollments.find(
        (item) =>
          item.studentId === studentId &&
          item.courseCode === course.code &&
          (item.status === "registered" || item.status === "completed"),
      );
    if (existing) return { ok: false, error: `You are already registered for ${course.code}.` };

    if (this.seatsTaken(course.code) >= course.seats) {
      return { ok: false, error: `${course.code} is full. Contact the registrar for the waitlist.` };
    }

    const enrollment = {
      id: id("enr"),
      studentId,
      courseCode: course.code,
      termId: course.termId,
      status: "registered" as const,
      registeredAt: now.toISOString(),
    };
    this.store.mutate((data) => {
      data.enrollments.push(enrollment);
    });
    return { ok: true, value: enrollment };
  }

  changePassword(studentId: string, current: string, next: string): Result<true> {
    const student = this.student(studentId);
    if (!student) return { ok: false, error: "No such student." };
    if (!verifyPassword(current, student.passwordHash)) {
      return { ok: false, error: "Your current password is not correct.", fields: { current: "Not correct." } };
    }
    if (next.length < 10) {
      return { ok: false, error: "Choose a password of at least 10 characters.", fields: { next: "At least 10 characters." } };
    }
    if (next === current) {
      return { ok: false, error: "Choose a password you have not used here before.", fields: { next: "Must be different." } };
    }
    const hash = hashPassword(next);
    this.store.mutate((data) => {
      const target = data.students.find((item) => item.id === studentId);
      if (!target) return;
      target.passwordHash = hash;
      target.mustChangePassword = false;
      delete target.temporaryPasswordIssuedAt;
    });
    return { ok: true, value: true };
  }

  resetAccess(studentId: string, now: Date = new Date()): Result<{ tempPassword: string }> {
    const student = this.student(studentId);
    if (!student) return { ok: false, error: "No such student." };
    const tempPassword = temporaryPassword();
    const hash = hashPassword(tempPassword);
    this.store.mutate((data) => {
      const target = data.students.find((item) => item.id === studentId);
      if (!target) return;
      target.passwordHash = hash;
      target.mustChangePassword = true;
      target.temporaryPasswordIssuedAt = now.toISOString();
    });
    return { ok: true, value: { tempPassword } };
  }

  /** What the registrar dashboard shows before it renders a table. */
  summary(): RegistrySummary {
    const data = this.store.read();
    return {
      applications: data.applications.length,
      awaitingDecision: data.applications.filter((item) => item.status === "submitted" || item.status === "under_review").length,
      students: data.students.length,
      registrations: data.enrollments.filter((item) => item.status === "registered").length,
      mailboxesReserved: data.students.filter((item) => item.mailbox.status === "reserved").length,
      programs: PROGRAMS.length,
      courses: COURSES.length,
      terms: TERMS.length,
    };
  }
}

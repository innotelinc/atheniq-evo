/**
 * Removing demonstration records from an existing registry.
 *
 * New seeds carry `provenance: "demo"` on every record they write. Volumes
 * created before that marker existed still contain the seed's fixed ids, so the
 * purge recognises both shapes. Real records are never identified by name or
 * email: a person may legitimately share the demo student's name.
 */

import type { StoreData } from "./store.ts";

/** The ids every demonstration seed has used, with or without a marker. */
const LEGACY_DEMO_APPLICATION_IDS = new Set(["app_demo0001"]);
const LEGACY_DEMO_STUDENT_IDS = new Set(["lrn_demo0001"]);

export interface DemoRemovals {
  applications: number;
  students: number;
  enrollments: number;
}

export interface DemoPurgeResult {
  data: StoreData;
  removed: DemoRemovals;
  changed: boolean;
}

function isDemoApplication(application: StoreData["applications"][number], demoStudentIds: Set<string>): boolean {
  return (
    application.provenance === "demo" ||
    LEGACY_DEMO_APPLICATION_IDS.has(application.id) ||
    (application.studentId !== undefined && demoStudentIds.has(application.studentId))
  );
}

function isDemoStudent(student: StoreData["students"][number]): boolean {
  return student.provenance === "demo" || LEGACY_DEMO_STUDENT_IDS.has(student.id);
}

/** Validate the shape a purge is willing to rewrite. */
export function isStoreData(value: unknown): value is StoreData {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  if (data.version !== 1) return false;
  if (!Array.isArray(data.applications) || !Array.isArray(data.students) || !Array.isArray(data.enrollments)) {
    return false;
  }
  const counters = data.counters;
  return (
    typeof counters === "object" &&
    counters !== null &&
    typeof (counters as Record<string, unknown>).student === "number"
  );
}

/**
 * Remove demo applications, students and their enrollments.
 *
 * `dryRun` computes the same removals without changing the input. Counters are
 * deliberately left alone: student numbers stay monotonic, and a gap is safer
 * than reusing a number that appeared on a document.
 */
export function purgeDemo(data: StoreData, dryRun = false): DemoPurgeResult {
  const demoStudentIds = new Set(data.students.filter(isDemoStudent).map((student) => student.id));

  const applicationIds = new Set(
    data.applications
      .filter((application) => isDemoApplication(application, demoStudentIds))
      .map((application) => application.id),
  );
  const enrollmentIds = new Set(
    data.enrollments
      .filter((enrollment) => enrollment.provenance === "demo" || demoStudentIds.has(enrollment.studentId))
      .map((enrollment) => enrollment.id),
  );

  const removed: DemoRemovals = {
    applications: applicationIds.size,
    students: demoStudentIds.size,
    enrollments: enrollmentIds.size,
  };

  if (dryRun || !Object.values(removed).some((count) => count > 0)) {
    return { data, removed, changed: Object.values(removed).some((count) => count > 0) };
  }

  return {
    data: {
      ...data,
      applications: data.applications.filter((application) => !applicationIds.has(application.id)),
      students: data.students.filter((student) => !demoStudentIds.has(student.id)),
      enrollments: data.enrollments.filter((enrollment) => !enrollmentIds.has(enrollment.id)),
    },
    removed,
    changed: true,
  };
}

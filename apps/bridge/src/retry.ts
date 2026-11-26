/**
 * Automatic completion delivery.
 *
 * A completion whose fan-out did not finish is recorded as `partial`. Until
 * now the only way to finish it was a human calling `?retry=1`. The sweep here
 * retries those records on their own schedule, with exponential backoff, and
 * makes the backlog visible: a service-authenticated list, a health check, and
 * one alert when a record has been partial long enough to need a person.
 */

import type { FlowDeps } from "./flow.ts";
import { retryCompletion } from "./flow.ts";

export interface NeedsRetryRecord {
  id: string;
  classroomId: string;
  learnerId: string;
  courseKey: string;
  receivedAt: string;
  ageSeconds: number;
  attempts: number;
  nextAttemptAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  /** True once the record has been partial longer than `alertAfterMs`. */
  stale: boolean;
}

export interface RetrySummary {
  count: number;
  stale: number;
  oldestAgeSeconds: number;
}

export interface SweepReport {
  checked: number;
  completed: number;
  stillPartial: number;
  failed: number;
}

function nowOf(deps: FlowDeps): Date {
  return (deps.now ?? (() => new Date()))();
}

function ageMs(receivedAt: string, now: Date): number {
  const received = Date.parse(receivedAt);
  if (!Number.isFinite(received)) return 0;
  return Math.max(0, now.getTime() - received);
}

/** Every partial completion, oldest first, whether or not it is due yet. */
export function needsRetry(deps: FlowDeps, now: Date = nowOf(deps)): NeedsRetryRecord[] {
  return deps.ledger
    .snapshot()
    .completions.filter((record) => record.status === "partial")
    .map((record) => {
      const age = ageMs(record.receivedAt, now);
      return {
        id: record.id,
        classroomId: record.classroomId,
        learnerId: record.learnerId,
        courseKey: record.courseKey,
        receivedAt: record.receivedAt,
        ageSeconds: Math.round(age / 1000),
        attempts: record.retry?.attempts ?? 0,
        nextAttemptAt: record.retry?.nextAttemptAt ?? null,
        lastAttemptAt: record.retry?.lastAttemptAt ?? null,
        lastError: record.retry?.lastError ?? null,
        stale: age >= deps.config.retry.alertAfterMs,
      };
    })
    .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
}

export function retrySummary(deps: FlowDeps, now: Date = nowOf(deps)): RetrySummary {
  const records = needsRetry(deps, now);
  return {
    count: records.length,
    stale: records.filter((record) => record.stale).length,
    oldestAgeSeconds: records[0]?.ageSeconds ?? 0,
  };
}

/**
 * One sweep: retry every partial record whose backoff has elapsed.
 *
 * A record that is currently being retried is skipped by `retryCompletion`,
 * so an overlapping sweep or a manual retry cannot run the same fan-out twice.
 */
export async function sweepRetries(deps: FlowDeps): Promise<SweepReport> {
  const report: SweepReport = { checked: 0, completed: 0, stillPartial: 0, failed: 0 };
  if (!deps.config.retry.enabled) return report;

  const now = nowOf(deps);
  const due = deps.ledger.snapshot().completions.filter((record) => {
    if (record.status !== "partial") return false;
    const at = record.retry?.nextAttemptAt;
    if (!at) return true;
    const dueAt = Date.parse(at);
    return !Number.isFinite(dueAt) || dueAt <= now.getTime();
  });

  for (const record of due) {
    report.checked += 1;
    try {
      const updated = await retryCompletion(deps, record.id);
      if (updated.status === "complete") report.completed += 1;
      else report.stillPartial += 1;
    } catch {
      // The failure is recorded on the ledger record with its next backoff.
      report.failed += 1;
    }
  }

  return report;
}

/**
 * Run the sweep immediately and then on the configured interval.
 *
 * The timer is unref'd so it never keeps a shutting-down process alive, and a
 * tick that is still running is not started a second time.
 */
export function startRetrySweep(deps: FlowDeps): { stop: () => void } {
  if (!deps.config.retry.enabled) return { stop: () => undefined };

  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await sweepRetries(deps);
    } catch (error) {
      deps.alert?.(`retry sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, deps.config.retry.intervalMs);
  timer.unref();
  void tick();

  return { stop: () => clearInterval(timer) };
}

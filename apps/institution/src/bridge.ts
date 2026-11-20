/**
 * Read-only view of the bridge's AI-instruction ledger.
 *
 * The institution portal shows the learner's own classroom record; it does not
 * write to the ledger, mint classroom tokens or award anything. Launching a
 * classroom stays in the console, which owns the launch flow and the cookie.
 *
 * Absent configuration is a normal state: the portal renders its empty state
 * rather than an error.
 */

import type { InstitutionConfig } from "./config.ts";

export interface TranscriptEntry {
  completionId?: string;
  courseKey?: string;
  completedAt?: string;
  grade?: { earned?: number; possible?: number; percent?: number };
  credential?: { verifyId?: string; status?: string } | null;
}

export interface TranscriptResult {
  ok: boolean;
  entries: TranscriptEntry[];
  note: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function fetchTranscript(config: InstitutionConfig, learnerId: string): Promise<TranscriptResult> {
  if (!config.bridgeUrl || !config.bridgeToken) {
    return { ok: false, entries: [], note: "The AI-classroom record is not connected in this environment." };
  }

  try {
    const response = await fetch(
      `${config.bridgeUrl}/v1/learners/${encodeURIComponent(learnerId)}/transcript`,
      {
        headers: { authorization: `Bearer ${config.bridgeToken}`, accept: "application/json" },
        signal: AbortSignal.timeout(3_000),
      },
    );
    if (!response.ok) {
      return { ok: false, entries: [], note: `The bridge answered HTTP ${response.status}.` };
    }
    const body: unknown = await response.json();
    const raw = isRecord(body) && Array.isArray(body.entries) ? body.entries : [];
    const entries = raw.filter(isRecord).map((entry) => ({
      completionId: typeof entry.completionId === "string" ? entry.completionId : undefined,
      courseKey: typeof entry.courseKey === "string" ? entry.courseKey : undefined,
      completedAt: typeof entry.completedAt === "string" ? entry.completedAt : undefined,
      grade: isRecord(entry.grade) ? (entry.grade as TranscriptEntry["grade"]) : undefined,
      credential: isRecord(entry.credential) ? (entry.credential as TranscriptEntry["credential"]) : null,
    }));
    return { ok: true, entries, note: "" };
  } catch (error) {
    return {
      ok: false,
      entries: [],
      note: `The bridge is unreachable (${error instanceof Error ? error.message : String(error)}).`,
    };
  }
}

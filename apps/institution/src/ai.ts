/**
 * Course generation for the console.
 *
 * Two engines, one contract. The model gateway (OmniRoute, OpenAI-compatible) is
 * used when the estate key is configured; the deterministic curriculum rules are
 * the fallback when it is not, or when it fails. The draft is validated before it
 * can reach the catalog, so a malformed reply cannot create a course that the
 * registrar cannot publish.
 *
 * The key never leaves the server: this module is imported by the service, never
 * by a view, and the gateway call is made here rather than in the browser.
 */

import type { InstitutionConfig } from "./config.ts";
import { coerceGrading, coerceModules, type CatalogCourse, type GradingComponent, type Module } from "./catalog.ts";

export type DraftEngine = "gateway" | "rules";

export interface CourseDraft {
  title: string;
  summary: string;
  description: string;
  outcomes: string[];
  prerequisites: string[];
  audience: string;
  instructor: string;
  format: string;
  credits: number;
  weeks: number;
  modules: Module[];
  grading: GradingComponent[];
}

export interface DraftResult {
  draft: CourseDraft;
  engine: DraftEngine;
  note: string;
}

const MAX_PROMPT = 2_000;

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, max) : "";
}

function list(value: unknown, limit: number, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => text(item, max))
    .filter(Boolean)
    .slice(0, limit);
}

/** Coerce a model reply into the draft schema. Missing fields are filled later. */
export function coerceDraft(value: unknown): CourseDraft | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const title = text(record.title, 160);
  const summary = text(record.summary, 800);
  if (!title || !summary) return null;
  const credits = Number(record.credits);
  const weeks = Number(record.weeks);
  return {
    title,
    summary,
    description: text(record.description, 4_000) || summary,
    outcomes: list(record.outcomes, 12, 300),
    prerequisites: list(record.prerequisites, 8, 200),
    audience: text(record.audience, 300),
    instructor: text(record.instructor, 120),
    format: text(record.format, 80),
    credits: Number.isFinite(credits) ? Math.min(60, Math.max(1, Math.round(credits))) : 15,
    weeks: Number.isFinite(weeks) ? Math.min(52, Math.max(1, Math.round(weeks))) : 12,
    modules: coerceModules(record.modules),
    grading: coerceGrading(record.grading),
  };
}

function titleFrom(prompt: string): string {
  let title = prompt
    .replace(/^(please\s+)?(create|write|design|build|generate|make)\s+(me\s+)?(a|an|the)?\s*(course|class)?\s*(about|on|for|in|covering)?\s*/i, "")
    .replace(/[.!?]+$/, "")
    .trim();
  if (!title) title = "New AthenIQ course";
  title = title.charAt(0).toUpperCase() + title.slice(1);
  return title.slice(0, 74);
}

const FALLBACK_GRADING: GradingComponent[] = [
  { component: "Participation", weight: 10 },
  { component: "Practice", weight: 30 },
  { component: "Module assessments", weight: 40 },
  { component: "Capstone", weight: 20 },
];

/**
 * The deterministic engine. It is deliberately structural rather than clever: a
 * complete, publishable course outline built from the prompt, so a console with
 * no gateway key still produces something a registrar can edit.
 */
export function rulesDraft(prompt: string): CourseDraft {
  const title = titleFrom(prompt);
  const topic = title.toLowerCase();
  const modules: Module[] = [
    {
      title: `Foundations of ${topic}`,
      summary: `The vocabulary and assumptions behind ${topic}: what the field claims, what it measures, and where the claims break.`,
      lessons: [
        { title: `What ${topic} is — and is not`, type: "lecture", minutes: 45 },
        { title: "Core vocabulary and a worked example", type: "reading", minutes: 40 },
        { title: "Practice set: recognise the pattern", type: "practice", minutes: 60 },
      ],
      assessment: "A short written analysis of one real case, with the assumptions named.",
    },
    {
      title: `Working with ${topic}`,
      summary: `Build the artefact: the tools, the data and the decisions that determine whether the result means anything.`,
      lessons: [
        { title: "Tooling and setup", type: "lab", minutes: 60 },
        { title: "A complete worked build", type: "lecture", minutes: 50 },
        { title: "Studio: build it yourself", type: "lab", minutes: 90 },
        { title: "Critique: what would falsify this?", type: "discussion", minutes: 45 },
      ],
      assessment: "A working artefact submitted with a short methods note.",
    },
    {
      title: `Judging ${topic}`,
      summary: "Evaluation, failure modes and the evidence a sceptical reader would accept.",
      lessons: [
        { title: "Evaluation design", type: "lecture", minutes: 45 },
        { title: "Failure modes and incident review", type: "reading", minutes: 40 },
        { title: "Peer review workshop", type: "discussion", minutes: 60 },
      ],
      assessment: "An evaluation plan with a stated baseline, metric and stopping rule.",
    },
    {
      title: `Applying ${topic}`,
      summary: "A scoped project against a real constraint, presented and defended.",
      lessons: [
        { title: "Scoping the project", type: "lecture", minutes: 40 },
        { title: "Supervised build", type: "lab", minutes: 120 },
        { title: "Presentation and defense", type: "assessment", minutes: 45 },
      ],
      assessment: "A demonstration, a written evaluation and an oral defense.",
    },
  ];

  return {
    title,
    summary: `An AthenIQ course on ${topic}. Studio teaching, a real build and assessment by what you can defend rather than what you can recall.`,
    description: `This course treats ${topic} as a practice rather than a survey. Each module ends in something you make: an analysis, an artefact, an evaluation plan and a defended project. Teaching happens in studios of no more than eighteen, and the AI classroom runs alongside the material for practice and questioning — never as the examiner.`,
    outcomes: [
      `Explain the central claims of ${topic} and the assumptions they rest on.`,
      `Build a working artefact that demonstrates ${topic} in practice.`,
      "Design an evaluation with a stated baseline and a stopping rule.",
      "Present and defend a technical choice to expert and non-expert audiences.",
    ],
    prerequisites: ["Comfort with written technical material", "A laptop that can run the course tooling"],
    audience: "Students and working professionals who need to apply this material, not only describe it",
    instructor: "Faculty of the Institute",
    format: "Studio · 12 weeks",
    credits: 15,
    weeks: 12,
    modules,
    grading: FALLBACK_GRADING.map((part) => ({ ...part })),
  };
}

function systemPrompt(): string {
  return [
    "You design university courses for AthenIQ Institute, a small studio-teaching institute.",
    "Answer with one JSON object and nothing else — no Markdown, no commentary.",
    "Schema:",
    '{"title":string,"summary":string,"description":string,"outcomes":string[],"prerequisites":string[],"audience":string,"instructor":string,"format":string,"credits":number,"weeks":number,"modules":[{"title":string,"summary":string,"lessons":[{"title":string,"type":"lecture"|"reading"|"practice"|"discussion"|"lab"|"assessment","minutes":number}],"assessment":string}],"grading":[{"component":string,"weight":number}]}',
    "Requirements: 3–6 modules; 2–6 lessons per module; grading weights are whole numbers that sum to 100; summary 40–800 characters; description 600–1,800 characters; 5–8 outcomes; no invented accreditation or partnership claims.",
  ].join("\n");
}

function extractJson(content: string): unknown {
  const trimmed = content.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
}

/**
 * Generate a draft. Never throws: a gateway failure is a rules draft with a note,
 * because a registrar pressing "Generate" deserves a result and an explanation,
 * not a stack trace.
 */
export async function generateDraft(
  config: InstitutionConfig,
  prompt: string,
  fetcher: typeof fetch = fetch,
): Promise<DraftResult> {
  const instruction = prompt.trim().slice(0, MAX_PROMPT);
  if (!config.omnirouteUrl || !config.omnirouteKey) {
    return {
      draft: rulesDraft(instruction),
      engine: "rules",
      note: "No model gateway key is configured, so the curriculum rules wrote this draft.",
    };
  }

  try {
    const response = await fetcher(`${config.omnirouteUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.omnirouteKey}`,
      },
      body: JSON.stringify({
        model: config.omnirouteModel,
        temperature: 0.4,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt() },
          { role: "user", content: instruction },
        ],
      }),
      signal: AbortSignal.timeout(45_000),
    });

    if (!response.ok) {
      throw new Error(`gateway answered HTTP ${response.status}`);
    }
    const payload = (await response.json()) as {
      choices?: { message?: { content?: unknown } }[];
    };
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error("the gateway returned no message content");
    const draft = coerceDraft(extractJson(content));
    if (!draft) throw new Error("the gateway reply did not match the course schema");
    if (draft.modules.length === 0) throw new Error("the gateway reply had no modules");

    return {
      draft: {
        ...draft,
        instructor: draft.instructor || "Faculty of the Institute",
        format: draft.format || "Studio · 12 weeks",
        grading: draft.grading.length > 0 ? draft.grading : FALLBACK_GRADING,
      },
      engine: "gateway",
      note: `Written by ${config.omnirouteModel} through the estate's model gateway.`,
    };
  } catch (error) {
    return {
      draft: rulesDraft(instruction),
      engine: "rules",
      note: `The model gateway did not answer (${error instanceof Error ? error.message : String(error)}), so the curriculum rules wrote this draft.`,
    };
  }
}

/** The next free code for a department, e.g. `AI103`. */
export function suggestCode(courses: CatalogCourse[], department: string): string {
  const prefix =
    (department || "General Studies")
      .replace(/[^A-Za-z]/g, "")
      .toUpperCase()
      .slice(0, 3) || "GEN";
  const used = courses
    .filter((course) => course.code.startsWith(prefix))
    .map((course) => Number.parseInt(course.code.slice(prefix.length), 10))
    .filter((value) => Number.isFinite(value));
  const next = (used.length > 0 ? Math.max(...used) : 100) + 1;
  return `${prefix}${String(next).padStart(3, "0")}`;
}

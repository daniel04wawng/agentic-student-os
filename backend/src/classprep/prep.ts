import { deriveIdempotencyKey } from '@student-os/shared';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { SqlClient } from '../db/client.js';
import type { EventBus } from '../events/bus.js';
import { splitCoursepack } from '../materials/split.js';
import type { ModelMessage } from '../model/provider.js';
import type { ModelService } from '../model/service.js';
import { createNotification } from '../notifications/service.js';

export const CLASS_PREP_READY = 'class.prep.ready';

export const PrepSchema = z.object({
  overview: z.string().default(''),
  prior_recap: z.string().default(''),
  key_points: z.array(z.string()).default([]),
  questions: z.array(z.string()).default([]),
  /** Worked reasoning through the material: for a case, the relevant numbers and calculations; for a concepts/programming topic, the mechanics worked with concrete examples. */
  analysis: z.string().default(''),
  /** The bottom line: for a case, the recommended decision with its supporting numbers; for a concepts topic, the correct approach/solution. */
  worked_answer: z.string().default(''),
});
export type Prep = z.infer<typeof PrepSchema>;

/** Per-material and total caps on how much material text is fed to the model. */
const PER_MATERIAL_CHARS = 9000;
const TOTAL_MATERIAL_CHARS = 18000;

export interface UpcomingClass {
  session_id: string;
  course_id: string | null;
  title: string | null;
  starts_at: string;
}

/**
 * Sessions starting within the window that need prep: those with no prep, those
 * whose prep is STALE (the course profile - session plans / case schedule -
 * changed after the prep was generated, e.g. the professor published the
 * session or a discussion was ingested), or all of them with `includePrepped`.
 */
export async function detectUpcomingClasses(
  db: SqlClient,
  opts: { now: string; withinHours: number; includePrepped?: boolean },
): Promise<UpcomingClass[]> {
  const { rows } = await db.query<UpcomingClass>(
    `SELECT s.id AS session_id, s.course_id, s.title,
            to_char(s.starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS starts_at
     FROM sessions s
     LEFT JOIN class_preps p ON p.session_id = s.id
     LEFT JOIN course_profiles cp ON cp.course_id = s.course_id
     LEFT JOIN LATERAL (
       SELECT max(m.updated_at) AS mt FROM materials m
       WHERE m.course_id = s.course_id AND (m.session_id = s.id OR m.session_id IS NULL)
     ) mat ON true
     WHERE ($3::bool OR p.id IS NULL
            OR (cp.updated_at IS NOT NULL AND p.generated_at < cp.updated_at)
            OR (mat.mt IS NOT NULL AND p.generated_at < mat.mt))
       AND s.starts_at IS NOT NULL
       AND s.starts_at >= $1::timestamptz
       AND s.starts_at <= $1::timestamptz + ($2 || ' hours')::interval
     ORDER BY s.starts_at`,
    [opts.now, String(opts.withinHours), opts.includePrepped ?? false],
  );
  return rows;
}

export interface PrepMaterial {
  title: string | null;
  kind: string;
  text: string;
}

/** The professor's published plan for this session (from the Ivey Session Summary). */
export interface SessionPlanContent {
  topic: string | null;
  readings: string[];
  questions: string[];
  caseTitle: string | null;
}

export interface PrepContext {
  courseName: string | null;
  priorSummaries: string[];
  readings: string[];
  /** Actual case/reading text for the session's course, bounded for the model. */
  materials: PrepMaterial[];
  /** The professor's plan for this specific class date, when known. */
  sessionPlan?: SessionPlanContent | null;
}

/**
 * Deterministic gathering of prep context for a session: prior-lecture
 * summaries, module/reading titles, and the actual materials text (cases first).
 * Material text is bounded per-item and in total so a huge case never blows the
 * model's context window; the model works from what fits.
 */
export async function gatherPrepContext(db: SqlClient, sessionId: string): Promise<PrepContext> {
  const ctx = await db.query<{
    course_id: string | null;
    course_name: string | null;
    session_date: string | null;
  }>(
    `SELECT s.course_id, c.name AS course_name,
            to_char(s.starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS session_date
     FROM sessions s LEFT JOIN courses c ON c.id = s.course_id WHERE s.id = $1`,
    [sessionId],
  );
  const courseId = ctx.rows[0]?.course_id ?? null;
  const sessionDate = ctx.rows[0]?.session_date ?? null;
  // The session's 1-based ordinal within its course, ordered by start time. Used
  // to match the Nth class meeting to the Nth case in a multi-case coursepack.
  const ordinal = courseId
    ? (
        await db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM sessions o
           JOIN sessions s ON s.id = $2
           WHERE o.course_id = $1 AND o.starts_at IS NOT NULL AND s.starts_at IS NOT NULL
             AND o.starts_at <= s.starts_at`,
          [courseId, sessionId],
        )
      ).rows[0]?.n ?? 1
    : 1;
  const summaries = courseId
    ? await db.query<{ text: string }>(
        `SELECT text FROM summaries WHERE course_id = $1 AND scope='session' ORDER BY updated_at`,
        [courseId],
      )
    : { rows: [] as { text: string }[] };
  const readings = courseId
    ? await db.query<{ titles: string[] | null }>(
        `SELECT ARRAY(SELECT jsonb_array_elements_text(profile->'module_titles')) AS titles
         FROM course_profiles WHERE course_id = $1`,
        [courseId],
      )
    : { rows: [] as { titles: string[] | null }[] };
  // Exact date -> case mapping from the course outline, when we have it:
  // profile.case_schedule is { "YYYY-MM-DD": <0-based case index> }. It overrides
  // the order-based fallback for the specific dates it lists.
  const scheduled =
    courseId && sessionDate
      ? (
          await db.query<{ idx: number | null }>(
            `SELECT (profile->'case_schedule'->>$2)::int AS idx
             FROM course_profiles WHERE course_id = $1`,
            [courseId, sessionDate],
          )
        ).rows[0]?.idx ?? null
      : null;
  // 0-based index of the case this session should prep: the outline's exact
  // assignment when present, otherwise the Nth meeting -> Nth case fallback.
  const caseIndex = scheduled ?? ordinal - 1;
  // The professor's published plan for THIS date (topic / readings / questions),
  // when we have it. Makes prep session-specific and lets us prep his own
  // questions instead of ones the model invents.
  const sessionPlan =
    courseId && sessionDate
      ? (
          await db.query<{ plan: SessionPlanContent | null }>(
            `SELECT profile->'session_plans'->$2 AS plan FROM course_profiles WHERE course_id = $1`,
            [courseId, sessionDate],
          )
        ).rows[0]?.plan ?? null
      : null;
  // This session's own assigned readings/case first (the actual material for the
  // class), then course-wide context; cases/readings ahead of the syllabus, and
  // shorter items first so a huge file never crowds out the assigned reading.
  const materialRows = courseId
    ? await db.query<{ title: string | null; kind: string; text: string }>(
        `SELECT title, kind, text FROM materials
         WHERE course_id = $1 AND (session_id = $2 OR session_id IS NULL) AND length(text) >= 20
         ORDER BY (session_id IS NOT NULL) DESC,
                  CASE kind WHEN 'case' THEN 0 WHEN 'reading' THEN 1 WHEN 'syllabus' THEN 2 ELSE 3 END,
                  length(text) ASC, updated_at DESC`,
        [courseId, sessionId],
      )
    : { rows: [] as { title: string | null; kind: string; text: string }[] };

  const materials: PrepMaterial[] = [];
  let budget = TOTAL_MATERIAL_CHARS;
  for (const r of materialRows.rows) {
    if (budget <= 0) break;
    // A coursepack bundles several cases in teaching order. Pick the one that
    // matches this session's ordinal (1st meeting -> 1st case) so each class
    // gets its assigned case, not always the first one in the file.
    let title = r.title;
    let text = r.text;
    if (r.kind === 'case') {
      const cases = splitCoursepack(r.text);
      if (cases.length > 1) {
        const picked = cases[Math.min(Math.max(caseIndex, 0), cases.length - 1)]!;
        title = r.title ? `${r.title} - ${picked.title}` : picked.title;
        text = picked.text;
      }
    }
    const take = Math.min(text.length, PER_MATERIAL_CHARS, budget);
    materials.push({ title, kind: r.kind, text: text.slice(0, take) });
    budget -= take;
  }

  return {
    courseName: ctx.rows[0]?.course_name ?? null,
    priorSummaries: summaries.rows.map((r) => r.text),
    readings: readings.rows[0]?.titles ?? [],
    materials,
    sessionPlan,
  };
}

/** Deterministic prep assembled from context (fallback / no-LLM path). */
export function buildPrepDeterministic(context: PrepContext): Prep {
  const materials = context.materials ?? [];
  const materialTitles = materials.map((m) => m.title ?? m.kind);
  return {
    overview: `Prep for ${context.courseName ?? 'class'}${context.sessionPlan?.topic ? ` - ${context.sessionPlan.topic}` : ''} based on ${context.priorSummaries.length} prior session(s) and ${materials.length} material(s).`,
    prior_recap: context.priorSummaries.slice(-2).join(' '),
    key_points: [...context.readings.slice(0, 5), ...materialTitles].slice(0, 6),
    // The professor's own questions when we have them, else none (no fabrication).
    questions: context.sessionPlan?.questions ?? [],
    // No model available: we cannot work the numbers, so leave the worked
    // sections empty rather than fabricate an answer.
    analysis: '',
    worked_answer: '',
  };
}

/** Render the gathered context into a single prompt the model reads. */
function renderContext(context: PrepContext): string {
  const parts: string[] = [`COURSE: ${context.courseName ?? 'Unknown'}`];
  const plan = context.sessionPlan;
  if (plan?.topic) parts.push(`\nTHIS SESSION'S TOPIC: ${plan.topic}`);
  if (plan?.readings?.length) parts.push(`\nASSIGNED READINGS:\n- ${plan.readings.join('\n- ')}`);
  if (plan?.questions?.length) {
    parts.push(
      `\nTHE PROFESSOR'S PREP QUESTIONS (prepare a clear answer to EACH of these; put the worked reasoning in analysis and the answers in worked_answer, and return them as the questions field):\n- ${plan.questions.join('\n- ')}`,
    );
  }
  if (context.priorSummaries.length > 0) {
    parts.push(`\nPRIOR LECTURE SUMMARIES:\n${context.priorSummaries.slice(-3).join('\n---\n')}`);
  }
  if (context.readings.length > 0) {
    parts.push(`\nREADING / MODULE TITLES:\n- ${context.readings.join('\n- ')}`);
  }
  if (context.materials.length > 0) {
    for (const m of context.materials) {
      parts.push(`\nMATERIAL (${m.kind}): ${m.title ?? 'untitled'}\n${m.text}`);
    }
  } else {
    parts.push('\n(No case/reading text is available for this session.)');
  }
  return parts.join('\n');
}

const PREP_SYSTEM = [
  'You prepare a student for an upcoming class. Read the prior-lecture summaries and the',
  'provided course materials (which may be a business case, an academic reading, or a',
  'programming/concepts topic) and produce prep as JSON with these fields:',
  '- overview: 2-3 sentences on what this class covers.',
  '- prior_recap: what earlier sessions covered, if any.',
  '- key_points: the essential ideas or facts to walk in knowing.',
  '- questions: questions the student should be ready to discuss or answer in class.',
  '- analysis: work THROUGH the material in detail. For a business case, identify the',
  '  decision and work the relevant numbers step by step (use the actual figures from the',
  '  case). For a concepts or programming topic, work the mechanics with concrete examples.',
  '- worked_answer: the bottom line. For a case, your recommended decision and the numbers',
  '  that support it. For a concepts topic, the correct approach or solution.',
  'Use only facts and numbers present in the materials; do not invent data. If the numbers',
  'needed are not present, say so in analysis rather than guessing.',
  'Keep it focused so the JSON stays complete: analysis about 6-10 sentences, worked_answer',
  'about 3-5 sentences, at most 6 key_points and at most 5 questions.',
].join(' ');

async function generatePrep(db: SqlClient, model: ModelService, sessionId: string): Promise<Prep> {
  const context = await gatherPrepContext(db, sessionId);
  const messages: ModelMessage[] = [
    { role: 'system', content: PREP_SYSTEM },
    { role: 'user', content: renderContext(context) },
  ];
  // 2048 output tokens comfortably fits a bounded prep; the field-length limits
  // in the prompt keep the JSON from being truncated before it closes.
  const prep = await model.generateStructured({ messages, maxTokens: 2048 }, PrepSchema, {
    fallback: () => buildPrepDeterministic(context),
  });
  // When the professor published his own prep questions, those are authoritative
  // -- prep against exactly what he'll ask, not questions the model invented.
  if (context.sessionPlan?.questions?.length) prep.questions = context.sessionPlan.questions;
  return prep;
}

/**
 * Prepare one class: synthesize prep, upsert the artifact (idempotent per
 * session), create a pre-class notification (dedup per session), and emit
 * `class.prep.ready`.
 */
export async function prepareClass(
  db: SqlClient,
  bus: EventBus,
  model: ModelService,
  sessionId: string,
): Promise<Prep> {
  const prep = await generatePrep(db, model, sessionId);
  const courseRow = await db.query<{ course_id: string | null }>(
    `SELECT course_id FROM sessions WHERE id = $1`,
    [sessionId],
  );
  const courseId = courseRow.rows[0]?.course_id ?? null;

  await db.query(
    `INSERT INTO class_preps (session_id, course_id, content, status)
     VALUES ($1, $2, $3::jsonb, 'ready')
     ON CONFLICT (session_id) DO UPDATE
       SET content = excluded.content, status = 'ready', generated_at = now()`,
    [sessionId, courseId, JSON.stringify(prep)],
  );

  await createNotification(db, {
    kind: 'info',
    title: 'Class prep ready',
    body: prep.overview,
    subjectType: 'session',
    subjectId: sessionId,
    dedupKey: `classprep:${sessionId}`,
  });

  await bus.publish({
    name: CLASS_PREP_READY,
    occurred_at: new Date().toISOString(),
    idempotency_key: deriveIdempotencyKey(['class', 'prep', sessionId]),
    trace_id: randomUUID(),
    source: 'system',
    subject_type: 'session',
    subject_id: sessionId,
    payload: { session_id: sessionId, course_id: courseId },
  });

  return prep;
}

/** True when a course has usable prep content (materials or prior summaries). */
async function courseHasContent(db: SqlClient, courseId: string | null): Promise<boolean> {
  if (!courseId) return false;
  const { rows } = await db.query<{ has: boolean }>(
    `SELECT (EXISTS(SELECT 1 FROM materials WHERE course_id = $1 AND length(text) >= 20)
          OR EXISTS(SELECT 1 FROM summaries WHERE course_id = $1)) AS has`,
    [courseId],
  );
  return rows[0]?.has ?? false;
}

/**
 * Detect upcoming classes and prepare each. With `requireContent` (used by the
 * scheduler), it skips sessions whose course has no materials or summaries, so
 * we never generate empty placeholder preps for a course we have nothing on.
 */
export async function prepareUpcoming(
  db: SqlClient,
  bus: EventBus,
  model: ModelService,
  opts: { now: string; withinHours: number; requireContent?: boolean; includePrepped?: boolean },
): Promise<number> {
  const upcoming = await detectUpcomingClasses(db, opts);
  let prepared = 0;
  for (const c of upcoming) {
    if (opts.requireContent && !(await courseHasContent(db, c.course_id))) continue;
    await prepareClass(db, bus, model, c.session_id);
    prepared += 1;
  }
  return prepared;
}

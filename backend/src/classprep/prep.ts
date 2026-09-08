import { deriveIdempotencyKey } from '@student-os/shared';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { SqlClient } from '../db/client.js';
import type { EventBus } from '../events/bus.js';
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

/** Sessions starting within the window that don't already have a prep. */
export async function detectUpcomingClasses(
  db: SqlClient,
  opts: { now: string; withinHours: number },
): Promise<UpcomingClass[]> {
  const { rows } = await db.query<UpcomingClass>(
    `SELECT s.id AS session_id, s.course_id, s.title,
            to_char(s.starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS starts_at
     FROM sessions s
     LEFT JOIN class_preps p ON p.session_id = s.id
     WHERE p.id IS NULL
       AND s.starts_at IS NOT NULL
       AND s.starts_at >= $1::timestamptz
       AND s.starts_at <= $1::timestamptz + ($2 || ' hours')::interval
     ORDER BY s.starts_at`,
    [opts.now, String(opts.withinHours)],
  );
  return rows;
}

export interface PrepMaterial {
  title: string | null;
  kind: string;
  text: string;
}

export interface PrepContext {
  courseName: string | null;
  priorSummaries: string[];
  readings: string[];
  /** Actual case/reading text for the session's course, bounded for the model. */
  materials: PrepMaterial[];
}

/**
 * Deterministic gathering of prep context for a session: prior-lecture
 * summaries, module/reading titles, and the actual materials text (cases first).
 * Material text is bounded per-item and in total so a huge case never blows the
 * model's context window; the model works from what fits.
 */
export async function gatherPrepContext(db: SqlClient, sessionId: string): Promise<PrepContext> {
  const ctx = await db.query<{ course_id: string | null; course_name: string | null }>(
    `SELECT s.course_id, c.name AS course_name FROM sessions s
     LEFT JOIN courses c ON c.id = s.course_id WHERE s.id = $1`,
    [sessionId],
  );
  const courseId = ctx.rows[0]?.course_id ?? null;
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
  // Cases first (they carry the numbers to work), then other materials.
  const materialRows = courseId
    ? await db.query<{ title: string | null; kind: string; text: string }>(
        `SELECT title, kind, text FROM materials
         WHERE course_id = $1 AND (session_id = $2 OR session_id IS NULL) AND length(text) >= 20
         ORDER BY (kind = 'case') DESC, updated_at DESC`,
        [courseId, sessionId],
      )
    : { rows: [] as { title: string | null; kind: string; text: string }[] };

  const materials: PrepMaterial[] = [];
  let budget = TOTAL_MATERIAL_CHARS;
  for (const r of materialRows.rows) {
    if (budget <= 0) break;
    const take = Math.min(r.text.length, PER_MATERIAL_CHARS, budget);
    materials.push({ title: r.title, kind: r.kind, text: r.text.slice(0, take) });
    budget -= take;
  }

  return {
    courseName: ctx.rows[0]?.course_name ?? null,
    priorSummaries: summaries.rows.map((r) => r.text),
    readings: readings.rows[0]?.titles ?? [],
    materials,
  };
}

/** Deterministic prep assembled from context (fallback / no-LLM path). */
export function buildPrepDeterministic(context: PrepContext): Prep {
  const materials = context.materials ?? [];
  const materialTitles = materials.map((m) => m.title ?? m.kind);
  return {
    overview: `Prep for ${context.courseName ?? 'class'} based on ${context.priorSummaries.length} prior session(s) and ${materials.length} material(s).`,
    prior_recap: context.priorSummaries.slice(-2).join(' '),
    key_points: [...context.readings.slice(0, 5), ...materialTitles].slice(0, 6),
    questions: [],
    // No model available: we cannot work the numbers, so leave the worked
    // sections empty rather than fabricate an answer.
    analysis: '',
    worked_answer: '',
  };
}

/** Render the gathered context into a single prompt the model reads. */
function renderContext(context: PrepContext): string {
  const parts: string[] = [`COURSE: ${context.courseName ?? 'Unknown'}`];
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
].join(' ');

async function generatePrep(db: SqlClient, model: ModelService, sessionId: string): Promise<Prep> {
  const context = await gatherPrepContext(db, sessionId);
  const messages: ModelMessage[] = [
    { role: 'system', content: PREP_SYSTEM },
    { role: 'user', content: renderContext(context) },
  ];
  return model.generateStructured({ messages, maxTokens: 3500 }, PrepSchema, {
    fallback: () => buildPrepDeterministic(context),
  });
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

/** Detect upcoming classes and prepare each. */
export async function prepareUpcoming(
  db: SqlClient,
  bus: EventBus,
  model: ModelService,
  opts: { now: string; withinHours: number },
): Promise<number> {
  const upcoming = await detectUpcomingClasses(db, opts);
  for (const c of upcoming) await prepareClass(db, bus, model, c.session_id);
  return upcoming.length;
}

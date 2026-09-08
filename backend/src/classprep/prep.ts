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
});
export type Prep = z.infer<typeof PrepSchema>;

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

export interface PrepContext {
  courseName: string | null;
  priorSummaries: string[];
  readings: string[];
}

/** Deterministic gathering of prior-lecture summaries + readings for a session. */
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
  return {
    courseName: ctx.rows[0]?.course_name ?? null,
    priorSummaries: summaries.rows.map((r) => r.text),
    readings: readings.rows[0]?.titles ?? [],
  };
}

/** Deterministic prep assembled from context (fallback / no-LLM path). */
export function buildPrepDeterministic(context: PrepContext): Prep {
  return {
    overview: `Prep for ${context.courseName ?? 'class'} based on ${context.priorSummaries.length} prior session(s).`,
    prior_recap: context.priorSummaries.slice(-2).join(' '),
    key_points: context.readings.slice(0, 5),
    questions: [],
  };
}

async function generatePrep(db: SqlClient, model: ModelService, sessionId: string): Promise<Prep> {
  const context = await gatherPrepContext(db, sessionId);
  const messages: ModelMessage[] = [
    {
      role: 'system',
      content:
        'Create class prep as JSON {"overview","prior_recap","key_points":[],"questions":[]} ' +
        'from the prior lecture summaries and readings.',
    },
    { role: 'user', content: JSON.stringify(context) },
  ];
  return model.generateStructured({ messages }, PrepSchema, {
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

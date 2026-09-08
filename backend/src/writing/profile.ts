import type { SqlClient } from '../db/client.js';
import { computeStyleFeatures, type StyleFeatures } from './features.js';

/** A single edit contributes only a small, bounded signal (no over-learning). */
export const EDIT_SIGNAL_WEIGHT = 0.2;

export interface AddSampleInput {
  source: 'self' | 'instructor' | 'exemplar';
  text: string;
  courseId?: string | null;
  personId?: string | null;
  deliverableKind?: string | null;
  weight?: number;
}

export async function addWritingSample(db: SqlClient, input: AddSampleInput): Promise<string> {
  const features = computeStyleFeatures(input.text);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO writing_samples (source, course_id, person_id, deliverable_kind, text, features, weight)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7) RETURNING id`,
    [
      input.source,
      input.courseId ?? null,
      input.personId ?? null,
      input.deliverableKind ?? null,
      input.text,
      JSON.stringify(features),
      input.weight ?? 1,
    ],
  );
  return rows[0]!.id;
}

/**
 * Record an edit-derived preference signal: the user's edited version becomes a
 * low-weight 'self' sample, so it nudges the style profile without a single
 * edit ever dominating it.
 */
export async function recordEditSignal(
  db: SqlClient,
  input: { text: string; courseId?: string | null; deliverableKind?: string | null },
): Promise<string> {
  return addWritingSample(db, {
    source: 'self',
    text: input.text,
    courseId: input.courseId ?? null,
    deliverableKind: input.deliverableKind ?? null,
    weight: EDIT_SIGNAL_WEIGHT,
  });
}

export interface StyleProfile {
  features: StyleFeatures;
  sample_count: number;
  total_weight: number;
}

export interface ProfileContext {
  courseId?: string | null;
  deliverableKind?: string | null;
  personId?: string | null;
}

interface SampleRow {
  features: StyleFeatures;
  weight: number;
  course_id: string | null;
  deliverable_kind: string | null;
  person_id: string | null;
}

/** Relevance multiplier: closer contextual matches weigh more. */
function relevance(sample: SampleRow, ctx: ProfileContext): number {
  let factor = 1;
  if (ctx.courseId && sample.course_id === ctx.courseId) factor *= 2;
  if (ctx.deliverableKind && sample.deliverable_kind === ctx.deliverableKind) factor *= 1.5;
  if (ctx.personId && sample.person_id === ctx.personId) factor *= 1.5;
  return factor * sample.weight;
}

/**
 * Build a contextual style profile: a weighted average of sample features,
 * weighting by contextual match (course/deliverable/professor) and each
 * sample's own weight.
 */
export async function buildStyleProfile(db: SqlClient, ctx: ProfileContext): Promise<StyleProfile> {
  const { rows } = await db.query<SampleRow>(
    `SELECT features, weight, course_id, deliverable_kind, person_id FROM writing_samples`,
  );
  const keys: (keyof StyleFeatures)[] = ['avg_sentence_len', 'type_token_ratio', 'formality'];
  const acc: Record<string, number> = { avg_sentence_len: 0, type_token_ratio: 0, formality: 0 };
  let totalWeight = 0;

  for (const row of rows) {
    const w = relevance(row, ctx);
    totalWeight += w;
    for (const k of keys) acc[k]! += (row.features[k] ?? 0) * w;
  }

  const features = {
    avg_sentence_len: totalWeight ? round(acc.avg_sentence_len! / totalWeight) : 0,
    type_token_ratio: totalWeight ? round(acc.type_token_ratio! / totalWeight) : 0,
    formality: totalWeight ? round(acc.formality! / totalWeight) : 0,
  };
  return { features, sample_count: rows.length, total_weight: round(totalWeight) };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

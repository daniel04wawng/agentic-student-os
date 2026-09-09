import type { SqlClient } from '../db/client.js';
import { buildStyleProfile, type ProfileContext } from './profile.js';

/** House style baked into every drafting prompt. */
export const HOUSE_STYLE_RULE =
  'Do not use em dashes (the long dash). Use commas, or split into separate sentences instead.';

/**
 * Guarantee the no-em-dash rule regardless of what the model returns: replace em
 * dashes (and the double-hyphen people type for one) with a comma. En dashes are
 * left alone since they are used for numeric ranges.
 */
export function stripEmDashes(text: string): string {
  return text
    .replace(/\s*—\s*/g, ', ') // — em dash
    .replace(/\s*―\s*/g, ', ') // ― horizontal bar
    .replace(/\s+--\s+/g, ', ') // spaced double hyphen used as em dash
    .replace(/ ,/g, ',');
}

export interface VoiceGuidance {
  hasSamples: boolean;
  excerpts: string[];
  features: { avg_sentence_len: number; type_token_ratio: number; formality: number };
}

const MAX_EXCERPTS = 2;
const EXCERPT_CHARS = 600;

/**
 * Gather the student's writing voice for a drafting context: a few of the most
 * relevant sample excerpts plus the aggregate style features. Empty (hasSamples
 * false) until the student uploads samples, in which case drafting proceeds on
 * house style alone.
 */
export async function gatherVoiceGuidance(db: SqlClient, ctx: ProfileContext): Promise<VoiceGuidance> {
  const profile = await buildStyleProfile(db, ctx);
  const { rows } = await db.query<{ text: string }>(
    `SELECT text FROM writing_samples
     WHERE ($1::uuid IS NULL OR course_id = $1) OR course_id IS NULL
     ORDER BY (course_id = $1) DESC, weight DESC, created_at DESC
     LIMIT $2`,
    [ctx.courseId ?? null, MAX_EXCERPTS],
  );
  return {
    hasSamples: profile.sample_count > 0,
    excerpts: rows.map((r) => r.text.slice(0, EXCERPT_CHARS)),
    features: profile.features,
  };
}

/** Render voice guidance into a prompt fragment (empty string when no samples). */
export function renderVoice(voice: VoiceGuidance): string {
  if (!voice.hasSamples || voice.excerpts.length === 0) return '';
  const f = voice.features;
  return [
    "Match the student's own writing voice. Aim for their typical rhythm",
    `(about ${Math.round(f.avg_sentence_len)} words per sentence) and formality.`,
    'Here are excerpts of their writing to imitate in tone and phrasing:',
    ...voice.excerpts.map((e, i) => `Sample ${i + 1}: ${e}`),
  ].join('\n');
}

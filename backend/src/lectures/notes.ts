import { z } from 'zod';
import type { ModelMessage } from '../model/provider.js';
import type { ModelService } from '../model/service.js';

/** Granola-style structured notes generated from a lecture transcript. */
export const LectureNotesSchema = z.object({
  /** 2-4 sentence plain-language overview of what the lecture covered. */
  summary: z.string().default(''),
  /** The main ideas/concepts taught, each a self-contained takeaway. */
  key_points: z.array(z.string()).default([]),
  /** Short topic tags for the lecture (for grouping/search). */
  topics: z.array(z.string()).default([]),
  /** Things the student must do: assignments, deadlines, readings, to-review. */
  action_items: z.array(z.string()).default([]),
  /** Open questions or points to clarify with the professor/peers. */
  questions: z.array(z.string()).default([]),
});
export type LectureNotes = z.infer<typeof LectureNotesSchema>;

/** How much transcript text to feed the model (bounded to protect context). */
const TRANSCRIPT_CHARS = 24000;

const NOTES_SYSTEM = [
  'You take the raw transcript of a university lecture and produce clean, useful study',
  'notes as JSON, the way a great note-taking assistant would. Fields:',
  '- summary: 2-4 sentences on what the lecture actually covered.',
  '- key_points: the essential ideas, concepts, and conclusions taught, in the order',
  '  they came up. Each point stands on its own and captures a real takeaway, not filler.',
  '- topics: a few short topic tags (2-5 words each).',
  '- action_items: concrete things the student must do that were mentioned - assignments,',
  '  due dates, readings to complete, things to review or practice. Empty if none.',
  '- questions: open questions or points worth clarifying afterward.',
  'Use only what is in the transcript; do not invent facts, names, or dates. Transcripts',
  'may be messy (disfluencies, mis-transcriptions) - infer meaning but stay faithful.',
  'Keep it tight: at most 10 key_points, 6 topics, 8 action_items, 6 questions.',
].join(' ');

/** Deterministic fallback notes when no model is available (no fabrication). */
export function buildNotesDeterministic(transcript: string): LectureNotes {
  const clean = transcript.replace(/\s+/g, ' ').trim();
  return {
    summary: clean ? `${clean.slice(0, 400)}${clean.length > 400 ? '...' : ''}` : '',
    key_points: [],
    topics: [],
    action_items: [],
    questions: [],
  };
}

/**
 * Generate Granola-style notes from a lecture transcript. Bounds the transcript
 * to protect the context window and falls back to a deterministic excerpt when
 * the model is unavailable (never fabricates).
 */
export async function generateLectureNotes(
  model: ModelService,
  transcript: string,
  context: { courseName?: string | null } = {},
): Promise<LectureNotes> {
  const bounded = transcript.slice(0, TRANSCRIPT_CHARS);
  const header = context.courseName ? `COURSE: ${context.courseName}\n\n` : '';
  const messages: ModelMessage[] = [
    { role: 'system', content: NOTES_SYSTEM },
    { role: 'user', content: `${header}LECTURE TRANSCRIPT:\n${bounded}` },
  ];
  return model.generateStructured({ messages, maxTokens: 2048 }, LectureNotesSchema, {
    fallback: () => buildNotesDeterministic(transcript),
  });
}

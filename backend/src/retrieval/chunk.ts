import type { TranscriptUtterance } from '../transcription/provider.js';

export interface Chunk {
  text: string;
  start_s: number | null;
  end_s: number | null;
}

const DEFAULT_MAX_CHARS = 800;

/**
 * Group diarized utterances into retrieval chunks up to ~maxChars, preserving
 * the start/end timestamps of the span. Falls back to raw-text splitting when
 * there are no utterances.
 */
export function chunkUtterances(
  utterances: TranscriptUtterance[],
  maxChars = DEFAULT_MAX_CHARS,
): Chunk[] {
  const chunks: Chunk[] = [];
  let buf: string[] = [];
  let start: number | null = null;
  let end: number | null = null;

  const flush = (): void => {
    if (buf.length === 0) return;
    chunks.push({ text: buf.join(' ').trim(), start_s: start, end_s: end });
    buf = [];
    start = null;
    end = null;
  };

  for (const u of utterances) {
    const text = u.text.trim();
    if (text.length === 0) continue;
    const projected = buf.reduce((n, s) => n + s.length + 1, 0) + text.length;
    if (buf.length > 0 && projected > maxChars) flush();
    if (start === null) start = u.start;
    end = u.end;
    buf.push(text);
  }
  flush();
  return chunks;
}

/** Split raw text into ~maxChars chunks on sentence-ish boundaries. */
export function chunkText(text: string, maxChars = DEFAULT_MAX_CHARS): Chunk[] {
  const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);
  const chunks: Chunk[] = [];
  let buf: string[] = [];
  const flush = (): void => {
    if (buf.length === 0) return;
    chunks.push({ text: buf.join(' ').trim(), start_s: null, end_s: null });
    buf = [];
  };
  for (const s of sentences) {
    const projected = buf.reduce((n, x) => n + x.length + 1, 0) + s.length;
    if (buf.length > 0 && projected > maxChars) flush();
    buf.push(s.trim());
  }
  flush();
  return chunks;
}

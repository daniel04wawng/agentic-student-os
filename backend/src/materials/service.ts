import { randomUUID } from 'node:crypto';
import { resolveCourseFiles, type CanvasContentClient } from '../canvas/client.js';
import type { CanvasFile } from '../canvas/types.js';
import type { SqlClient } from '../db/client.js';
import { extractText as defaultExtract, type Extractor } from './extract.js';

export interface IngestFileInput {
  courseId?: string | null;
  sessionId?: string | null;
  kind?: string;
  title?: string | null;
  contentType?: string | null;
  source?: 'canvas' | 'manual';
  sourceId?: string | null;
  sourceUrl?: string | null;
  bytes: Buffer;
  /** Skip storing when the extracted text is shorter than this (scanned-image PDFs). */
  minChars?: number;
}

export interface IngestResult {
  /** Null when the file was skipped (e.g. a scanned PDF with no text layer). */
  materialId: string | null;
  chars: number;
  skipped: boolean;
}

/**
 * Extract text from bytes and store it. The `bytes` are used only to extract and
 * then go out of scope — no PDF is written to disk. Idempotent on (source,
 * source_id) when a source id is provided.
 */
export async function ingestFileBytes(
  db: SqlClient,
  input: IngestFileInput,
  extract: Extractor = defaultExtract,
): Promise<IngestResult> {
  const text = await extract(input.bytes, input.contentType ?? '');
  if (input.minChars != null && text.trim().length < input.minChars) {
    return { materialId: null, chars: text.length, skipped: true };
  }
  const source = input.source ?? 'canvas';
  const sourceId = input.sourceId ?? null;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO materials (course_id, session_id, kind, title, content_type, byte_size, text, source, source_id, source_url)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::provider,$9,$10)
     ON CONFLICT (source, source_id) WHERE source_id IS NOT NULL
     DO UPDATE SET text = excluded.text, title = excluded.title,
                   content_type = excluded.content_type, byte_size = excluded.byte_size
       -- Only touch the row (and its updated_at) on a real content change, so it
       -- can drive prep refresh without churning on every identical re-sync.
       WHERE materials.text IS DISTINCT FROM excluded.text
     RETURNING id`,
    [
      input.courseId ?? null,
      input.sessionId ?? null,
      input.kind ?? 'reading',
      input.title ?? null,
      input.contentType ?? null,
      input.bytes.length,
      text,
      source,
      sourceId,
      input.sourceUrl ?? null,
    ],
  );
  // No row when the conflict target existed and the text was unchanged: fetch it.
  const materialId =
    rows[0]?.id ??
    (
      await db.query<{ id: string }>(
        `SELECT id FROM materials WHERE source = $1::provider AND source_id = $2`,
        [source, sourceId],
      )
    ).rows[0]!.id;
  return { materialId, chars: text.length, skipped: false };
}

/** Download a Canvas file, extract its text in memory, and store just the text. */
export async function ingestCanvasFile(
  db: SqlClient,
  client: CanvasContentClient,
  courseId: string,
  file: CanvasFile,
  opts: { sessionId?: string | null; extract?: Extractor; minChars?: number } = {},
): Promise<IngestResult> {
  const bytes = await client.downloadFile(file.url); // ephemeral; discarded after extraction
  return ingestFileBytes(
    db,
    {
      courseId,
      sessionId: opts.sessionId ?? null,
      kind: /case/i.test(file.display_name) ? 'case' : 'reading',
      title: file.display_name,
      contentType: file.content_type ?? file['content-type'] ?? null,
      source: 'canvas',
      sourceId: String(file.id),
      sourceUrl: file.url,
      bytes,
      minChars: opts.minChars,
    },
    opts.extract,
  );
}

export interface CourseFilesResult {
  found: number;
  ingested: number;
  skipped: number;
  files: { title: string; chars: number; skipped: boolean }[];
}

/**
 * Discover and ingest a course's files (readings/cases the prof posts). Uses the
 * modules fallback when the `/files` list is 403, extracts text in memory, and
 * stores only the text. Scanned-image PDFs (no text layer) are skipped, not
 * stored, and reported so they can be OCR'd or dropped in manually.
 */
export async function ingestCourseFiles(
  db: SqlClient,
  client: CanvasContentClient,
  courseId: string,
  canvasCourseId: number,
  opts: { minChars?: number; extract?: Extractor } = {},
): Promise<CourseFilesResult> {
  const minChars = opts.minChars ?? 20;
  const files = await resolveCourseFiles(client, canvasCourseId);
  const out: CourseFilesResult = { found: files.length, ingested: 0, skipped: 0, files: [] };
  for (const file of files) {
    const r = await ingestCanvasFile(db, client, courseId, file, { minChars, extract: opts.extract });
    if (r.skipped) out.skipped += 1;
    else out.ingested += 1;
    out.files.push({ title: file.display_name, chars: r.chars, skipped: r.skipped });
  }
  return out;
}

/** Ingest a PDF the user dropped in (purchased case they legitimately have). */
export async function ingestUploadedPdf(
  db: SqlClient,
  input: { courseId?: string | null; sessionId?: string | null; title: string; bytes: Buffer },
  extract: Extractor = defaultExtract,
): Promise<IngestResult> {
  return ingestFileBytes(
    db,
    {
      courseId: input.courseId ?? null,
      sessionId: input.sessionId ?? null,
      kind: 'case',
      title: input.title,
      contentType: 'application/pdf',
      source: 'manual',
      sourceId: `upload:${randomUUID()}`,
      bytes: input.bytes,
    },
    extract,
  );
}

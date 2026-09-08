import { randomUUID } from 'node:crypto';
import type { CanvasContentClient } from '../canvas/client.js';
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
): Promise<{ materialId: string; chars: number }> {
  const text = await extract(input.bytes, input.contentType ?? '');
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO materials (course_id, session_id, kind, title, content_type, byte_size, text, source, source_id, source_url)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::provider,$9,$10)
     ON CONFLICT (source, source_id) WHERE source_id IS NOT NULL
     DO UPDATE SET text = excluded.text, title = excluded.title,
                   content_type = excluded.content_type, byte_size = excluded.byte_size
     RETURNING id`,
    [
      input.courseId ?? null,
      input.sessionId ?? null,
      input.kind ?? 'reading',
      input.title ?? null,
      input.contentType ?? null,
      input.bytes.length,
      text,
      input.source ?? 'canvas',
      input.sourceId ?? null,
      input.sourceUrl ?? null,
    ],
  );
  return { materialId: rows[0]!.id, chars: text.length };
}

/** Download a Canvas file, extract its text in memory, and store just the text. */
export async function ingestCanvasFile(
  db: SqlClient,
  client: CanvasContentClient,
  courseId: string,
  file: CanvasFile,
  opts: { sessionId?: string | null; extract?: Extractor } = {},
): Promise<{ materialId: string; chars: number }> {
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
    },
    opts.extract,
  );
}

/** Ingest a PDF the user dropped in (purchased case they legitimately have). */
export async function ingestUploadedPdf(
  db: SqlClient,
  input: { courseId?: string | null; sessionId?: string | null; title: string; bytes: Buffer },
  extract: Extractor = defaultExtract,
): Promise<{ materialId: string; chars: number }> {
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

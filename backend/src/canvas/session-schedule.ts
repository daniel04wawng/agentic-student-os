import type { CanvasContentClient } from './client.js';
import type { SqlClient } from '../db/client.js';

/** Crude HTML -> readable text for storing/searching Canvas page bodies. */
export function stripHtml(input: string): string {
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<(p|br|div|h\d|tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&rsquo;|&lsquo;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

interface SessionRow {
  id: string;
  title: string | null;
  starts_at: string | null;
  metadata: { canvas_event_id?: number } | null;
}

/**
 * Ingest each session's Canvas detail Page (topic + assigned readings +
 * refresher primer) as a searchable resource_chunk, so the study chat can answer
 * "I'm on session 8, what primer do I need?". The detail lives on a Canvas Page
 * linked from the session's calendar-event description. Idempotent per session.
 * Best-effort: unpublished future sessions 403 and are simply skipped.
 */
export async function syncSessionSchedules(
  db: SqlClient,
  client: CanvasContentClient,
  courseId: string,
): Promise<number> {
  if (!client.getCalendarEvent || !client.getPageBody) return 0;

  const { rows } = await db.query<SessionRow>(
    `SELECT id, title, starts_at, metadata FROM sessions
     WHERE course_id = $1 AND metadata ? 'canvas_event_id'
     ORDER BY starts_at`,
    [courseId],
  );

  let ingested = 0;
  for (const s of rows) {
    const eventId = s.metadata?.canvas_event_id;
    const num = /Session\s+(\d+)/i.exec(s.title ?? '')?.[1];
    if (!eventId || !num) continue;
    try {
      const ev = await client.getCalendarEvent(Number(eventId));
      const pm = /\/courses\/(\d+)\/pages\/([^"'?]+)/.exec(ev.description ?? '');
      if (!pm) continue;
      const text = stripHtml(await client.getPageBody(Number(pm[1]), pm[2]!));
      if (text.length < 40) continue;
      const date = s.starts_at ? new Date(s.starts_at).toISOString().slice(0, 10) : '';
      const body = `Session ${num} (${date})\n\n${text}`;
      const title = `Session ${num} schedule`;
      // Idempotent: replace any prior copy for this session.
      await db.query(`DELETE FROM resource_chunks WHERE course_id = $1 AND source_title = $2`, [
        courseId,
        title,
      ]);
      await db.query(
        `INSERT INTO resource_chunks (course_id, source_title, section, chunk_index, text)
         VALUES ($1, $2, $3, 0, $4)`,
        [courseId, title, date, body],
      );
      ingested += 1;
    } catch {
      // Best-effort: a 403 (unpublished) or missing page must not break the sync.
    }
  }
  return ingested;
}

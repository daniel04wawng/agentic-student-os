import type { CanvasContentClient } from '../canvas/client.js';
import { ingestCalendars, ingestCanvas } from '../canvas/ingest.js';
import type { CanvasCourse } from '../canvas/types.js';
import type { SqlClient } from '../db/client.js';
import type { EventBus } from '../events/bus.js';
import { ingestFileBytes } from '../materials/service.js';

/** Pull a course's outline PDF (linked from its syllabus) and ingest it as material. */
async function syncCourseOutline(
  db: SqlClient,
  client: CanvasContentClient,
  canvasCourseId: number,
): Promise<boolean> {
  const course = (await client.getCourse(canvasCourseId)) as CanvasCourse & { syllabus_body?: string };
  const html = course.syllabus_body ?? '';
  // First Canvas file link in the syllabus is (by Ivey convention) the outline.
  const fileId = /\/files\/(\d+)/.exec(html)?.[1];
  if (!fileId) return false;
  const row = await db.query<{ id: string }>(`SELECT id FROM courses WHERE source='canvas' AND source_id=$1`, [
    String(canvasCourseId),
  ]);
  const courseId = row.rows[0]?.id;
  if (!courseId) return false;
  try {
    const file = await client.getFile(canvasCourseId, Number(fileId));
    const bytes = await client.downloadFile(file.url);
    await ingestFileBytes(db, {
      courseId,
      kind: 'syllabus',
      title: file.display_name,
      contentType: file.content_type ?? file['content-type'] ?? null,
      source: 'canvas',
      sourceId: String(fileId),
      bytes,
      minChars: 20,
    });
    return true;
  } catch {
    return false; // outline behind a paywall/LTI or unreadable; skip
  }
}

/** One full Canvas sync pass: courses + assignments, calendars, and outlines. */
export async function runCanvasSync(
  db: SqlClient,
  client: CanvasContentClient,
  bus: EventBus,
  now: () => string = () => new Date().toISOString(),
): Promise<{ courses: number; sessions: number; outlines: number }> {
  const ingest = await ingestCanvas(client, bus);
  const activeIds = (
    await db.query<{ source_id: string }>(
      `SELECT source_id FROM courses WHERE status <> 'archived' AND source = 'canvas' AND source_id IS NOT NULL`,
    )
  ).rows.map((r) => Number(r.source_id));

  const nowD = new Date(now());
  const startDate = nowD.toISOString().slice(0, 10);
  const endDate = new Date(nowD.getTime() + 120 * 86_400_000).toISOString().slice(0, 10);
  const cal = await ingestCalendars(client, bus, activeIds, { startDate, endDate, now });

  let outlines = 0;
  for (const id of activeIds) {
    if (await syncCourseOutline(db, client, id)) outlines += 1;
  }
  return { courses: ingest.courses, sessions: cal.sessions, outlines };
}

export interface CanvasSyncOptions {
  intervalMs?: number; // default 6h
  now?: () => string;
  onTick?: (r: { courses: number; sessions: number; outlines: number } | { error: string }) => void;
}

/** Periodically sync Canvas so deadlines, sessions, and materials stay current. */
export function startCanvasSync(
  db: SqlClient,
  client: CanvasContentClient,
  bus: EventBus,
  opts: CanvasSyncOptions = {},
): () => void {
  const intervalMs = opts.intervalMs ?? 6 * 60 * 60 * 1000;
  const now = opts.now ?? (() => new Date().toISOString());
  let inFlight = false;
  const tick = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    try {
      opts.onTick?.(await runCanvasSync(db, client, bus, now));
    } catch (err) {
      opts.onTick?.({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      inFlight = false;
    }
  };
  void tick();
  const handle = setInterval(() => void tick(), intervalMs);
  if (typeof handle === 'object' && 'unref' in handle) handle.unref();
  return () => clearInterval(handle);
}

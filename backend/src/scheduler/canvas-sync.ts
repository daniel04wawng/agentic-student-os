import { resolveCourseFiles, type CanvasContentClient } from '../canvas/client.js';
import { ingestCalendars, ingestCanvas } from '../canvas/ingest.js';
import type { CanvasCourse, CanvasFile } from '../canvas/types.js';
import { syncIveyCaseSchedule } from '../classprep/ivey-schedule.js';
import type { SqlClient } from '../db/client.js';
import type { EventBus } from '../events/bus.js';
import { ingestFileBytes } from '../materials/service.js';

/** Classify a course file by its name (best-effort). */
function classifyMaterial(name: string): string {
  if (/case|coursepack|casebook|course.?pack|IP_ECP|sep\.?\s*dist/i.test(name)) return 'case';
  if (/outline|syllabus/i.test(name)) return 'syllabus';
  return 'reading';
}

/** Only text-extractable files are worth ingesting (skip images, etc.). */
function isReadable(contentType: string | undefined, name: string): boolean {
  const ct = (contentType ?? '').toLowerCase();
  if (ct.includes('pdf') || /\.pdf$/i.test(name)) return true;
  if (ct.startsWith('text/') || /\.(txt|md|csv)$/i.test(name)) return true;
  return false; // images (png/svg/jpg) and docx (no clean extractor yet) are skipped
}

/**
 * Find and read EVERY readable file in a course, from every source: the course
 * files list (or its module-item fallback when the list is 403), plus everything
 * linked from the syllabus (outline, coursepack/casebook, readings, textbook).
 * Each PDF/text file is downloaded, its text extracted in memory, and stored as
 * material; bytes are discarded. Idempotent on (source, file id). Images and
 * LTI/paywalled items are skipped.
 */
async function syncCourseMaterials(
  db: SqlClient,
  client: CanvasContentClient,
  canvasCourseId: number,
): Promise<number> {
  const row = await db.query<{ id: string }>(`SELECT id FROM courses WHERE source='canvas' AND source_id=$1`, [
    String(canvasCourseId),
  ]);
  const courseId = row.rows[0]?.id;
  if (!courseId) return 0;

  // Gather candidate files from every source, deduped by file id.
  const byId = new Map<string, CanvasFile>();
  try {
    for (const f of await resolveCourseFiles(client, canvasCourseId)) byId.set(String(f.id), f);
  } catch {
    // files list + modules both unavailable; syllabus links may still work
  }
  try {
    const course = (await client.getCourse(canvasCourseId)) as CanvasCourse & { syllabus_body?: string };
    const ids = [
      ...new Set(
        [...(course.syllabus_body ?? '').matchAll(/\/files\/(\d+)/g)]
          .map((m) => m[1])
          .filter((x): x is string => Boolean(x)),
      ),
    ];
    for (const id of ids) {
      if (byId.has(id)) continue;
      try {
        byId.set(id, await client.getFile(canvasCourseId, Number(id)));
      } catch {
        // a single unreadable file must not stop discovery
      }
    }
  } catch {
    // no syllabus body
  }

  let ingested = 0;
  for (const file of byId.values()) {
    const ct = file.content_type ?? file['content-type'] ?? undefined;
    if (!isReadable(ct, file.display_name)) continue;
    try {
      const bytes = await client.downloadFile(file.url);
      const r = await ingestFileBytes(db, {
        courseId,
        kind: classifyMaterial(file.display_name),
        title: file.display_name,
        contentType: ct ?? null,
        source: 'canvas',
        sourceId: String(file.id),
        bytes,
        minChars: 20,
      });
      if (!r.skipped) ingested += 1;
    } catch {
      // paywalled/unreadable download; skip
    }
  }
  return ingested;
}

export interface RunCanvasSyncOptions {
  now?: () => string;
  /** When set, refresh each course's exact date->case schedule from its Ivey
   * Session Summary LTI tool (best-effort). */
  iveyAuth?: { baseUrl: string; token: string };
}

/** One full Canvas sync pass: courses + assignments, calendars, materials, and
 * (when Ivey auth is provided) the exact per-session case schedule. */
export async function runCanvasSync(
  db: SqlClient,
  client: CanvasContentClient,
  bus: EventBus,
  opts: RunCanvasSyncOptions = {},
): Promise<{ courses: number; sessions: number; materials: number; scheduled: number }> {
  const now = opts.now ?? (() => new Date().toISOString());
  const ingest = await ingestCanvas(client, bus);
  const active = (
    await db.query<{ id: string; source_id: string }>(
      `SELECT id, source_id FROM courses WHERE status <> 'archived' AND source = 'canvas' AND source_id IS NOT NULL`,
    )
  ).rows;
  const activeIds = active.map((r) => Number(r.source_id));

  const nowD = new Date(now());
  const startDate = nowD.toISOString().slice(0, 10);
  const endDate = new Date(nowD.getTime() + 120 * 86_400_000).toISOString().slice(0, 10);
  const cal = await ingestCalendars(client, bus, activeIds, { startDate, endDate, now });

  let materials = 0;
  let scheduled = 0;
  for (const c of active) {
    materials += await syncCourseMaterials(db, client, Number(c.source_id));
    // Materials are ingested first so the coursepack exists to match against.
    if (opts.iveyAuth) {
      scheduled += await syncIveyCaseSchedule(db, opts.iveyAuth, Number(c.source_id), c.id);
    }
  }
  return { courses: ingest.courses, sessions: cal.sessions, materials, scheduled };
}

export interface CanvasSyncOptions {
  intervalMs?: number; // default 6h
  now?: () => string;
  iveyAuth?: { baseUrl: string; token: string };
  onTick?: (
    r: { courses: number; sessions: number; materials: number; scheduled: number } | { error: string },
  ) => void;
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
      opts.onTick?.(await runCanvasSync(db, client, bus, { now, iveyAuth: opts.iveyAuth }));
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

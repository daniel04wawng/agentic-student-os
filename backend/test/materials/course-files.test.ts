import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CanvasError, type CanvasContentClient } from '../../src/canvas/client.js';
import type { CanvasFile } from '../../src/canvas/types.js';
import { ingestCourseFiles } from '../../src/materials/service.js';
import { freshDb, resetDb } from '../db/helpers.js';

let db: PGlite;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.close(); });
beforeEach(async () => { await resetDb(db); });

async function seedCourse(): Promise<string> {
  const c = await db.query<{ id: string }>(
    `INSERT INTO courses (name, source, source_id) VALUES ('C','canvas','6768') RETURNING id`,
  );
  return c.rows[0]!.id;
}

// A text file extracts fine; a scanned PDF yields ~nothing.
const extract = async (_b: Buffer, _ct: string) =>
  _b.toString('utf8').startsWith('SCANNED') ? '  ' : 'CASE TEXT revenue 500 cost 300';

describe('ingestCourseFiles', () => {
  it('falls back through modules, ingests text files, and skips scanned PDFs', async () => {
    const courseId = await seedCourse();
    const files: CanvasFile[] = [
      { id: 1, display_name: 'Real Case.pdf', url: 'https://dl/1', content_type: 'application/pdf' },
      { id: 2, display_name: 'Scanned Reading.pdf', url: 'https://dl/2', content_type: 'application/pdf' },
    ];
    const client = {
      listFiles: async () => { throw new CanvasError('403', 403); },
      listFilesViaModules: async () => files,
      downloadFile: async (url: string) =>
        url.endsWith('/2') ? Buffer.from('SCANNED-bytes') : Buffer.from('%PDF real'),
    } as unknown as CanvasContentClient;

    const r = await ingestCourseFiles(db, client, courseId, 6768, { extract });
    expect(r.found).toBe(2);
    expect(r.ingested).toBe(1);
    expect(r.skipped).toBe(1);

    const rows = await db.query<{ n: number }>(`SELECT count(*)::int n FROM materials`);
    expect(rows.rows[0]!.n).toBe(1); // only the real case stored; scanned one not persisted

    const stored = await db.query<{ title: string; kind: string }>(
      `SELECT title, kind FROM materials`,
    );
    expect(stored.rows[0]).toMatchObject({ title: 'Real Case.pdf', kind: 'case' });
  });
});

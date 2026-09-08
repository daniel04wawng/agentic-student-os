import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CanvasContentClient } from '../../src/canvas/client.js';
import type { CanvasFile } from '../../src/canvas/types.js';
import { ingestCanvasFile, ingestUploadedPdf } from '../../src/materials/service.js';
import { freshDb, resetDb } from '../db/helpers.js';

let db: PGlite;
beforeAll(async () => {
  db = await freshDb();
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await resetDb(db);
});

async function seedCourse(): Promise<string> {
  const c = await db.query<{ id: string }>(
    `INSERT INTO courses (name, source, source_id) VALUES ('C','canvas','c1') RETURNING id`,
  );
  return c.rows[0]!.id;
}

// Fake extractor so DB behavior is tested without real PDF parsing.
const fakeExtract = async (_bytes: Buffer, _ct: string) => 'CASE TEXT: revenue 500, cost 300, decision: enter market.';

describe('ingestCanvasFile', () => {
  it('downloads, extracts text, stores just the text, and is idempotent', async () => {
    const courseId = await seedCourse();
    let downloaded = 0;
    const client = {
      downloadFile: async () => {
        downloaded += 1;
        return Buffer.from('%PDF-1.4 ...binary...');
      },
    } as unknown as CanvasContentClient;
    const file: CanvasFile = { id: 77, display_name: 'GlobalMacro Case.pdf', url: 'https://f/dl', content_type: 'application/pdf' };

    const r1 = await ingestCanvasFile(db, client, courseId, file, { extract: fakeExtract });
    expect(r1.chars).toBeGreaterThan(0);
    expect(downloaded).toBe(1);

    const row = await db.query<{ kind: string; text: string; bytes: number }>(
      `SELECT kind, text, byte_size AS bytes FROM materials WHERE source='canvas' AND source_id='77'`,
    );
    expect(row.rows[0]!.kind).toBe('case'); // filename contains "Case"
    expect(row.rows[0]!.text).toContain('revenue 500');
    expect(row.rows[0]!.bytes).toBeGreaterThan(0);

    await ingestCanvasFile(db, client, courseId, file, { extract: fakeExtract }); // idempotent
    const n = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM materials`);
    expect(n.rows[0]!.n).toBe(1);
  });
});

describe('ingestUploadedPdf', () => {
  it('stores a dropped-in case as a manual-source material', async () => {
    const courseId = await seedCourse();
    const r = await ingestUploadedPdf(
      db,
      { courseId, title: 'Purchased Case.pdf', bytes: Buffer.from('%PDF-1.4') },
      fakeExtract,
    );
    expect(r.chars).toBeGreaterThan(0);
    const row = await db.query<{ source: string; kind: string }>(
      `SELECT source, kind FROM materials WHERE id=$1`,
      [r.materialId],
    );
    expect(row.rows[0]).toMatchObject({ source: 'manual', kind: 'case' });
  });
});

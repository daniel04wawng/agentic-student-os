import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../../src/events/bus.js';
import { generateAssignment } from '../../src/generation/generate.js';
import { FakeGoogleDocsClient } from '../../src/google/client.js';
import { FakeModelProvider } from '../../src/model/provider.js';
import { ModelService } from '../../src/model/service.js';
import { buildReviewPacket, estimateReviewMinutes, getReviewPacket } from '../../src/review/packet.js';
import { freshDb, resetDb } from '../db/helpers.js';

let db: PGlite;
let bus: EventBus;
let google: FakeGoogleDocsClient;
const model = new ModelService(new FakeModelProvider(() => 'not json'));
beforeAll(async () => {
  db = await freshDb();
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await resetDb(db);
  bus = new EventBus(db);
  google = new FakeGoogleDocsClient();
});

async function reviewReadyAssignment(): Promise<string> {
  const c = await db.query<{ id: string }>(
    `INSERT INTO courses (name, source, source_id) VALUES ('C','canvas','c1') RETURNING id`,
  );
  const a = await db.query<{ id: string }>(
    `INSERT INTO assignments (course_id, title, status, source, source_id)
     VALUES ($1,'Essay','context_ready','canvas','a1') RETURNING id`,
    [c.rows[0]!.id],
  );
  await generateAssignment(db, { model, google, bus }, a.rows[0]!.id);
  return a.rows[0]!.id;
}

describe('estimateReviewMinutes', () => {
  it('scales with word count and has a floor', () => {
    expect(estimateReviewMinutes(0)).toBe(2);
    expect(estimateReviewMinutes(600)).toBeGreaterThan(estimateReviewMinutes(100));
  });
});

describe('buildReviewPacket', () => {
  it('produces summary/argument/warnings/version/link and is idempotent', async () => {
    const id = await reviewReadyAssignment();
    const packet = await buildReviewPacket(db, google, id);
    expect(packet.summary.length).toBeGreaterThan(0);
    expect(packet.main_argument.length).toBeGreaterThan(0);
    expect(packet.artifact_version).toBe(1);
    expect(packet.artifact_uri).toContain('docs.google.com');
    expect(packet.warnings).toContain('short_draft'); // fallback draft is short

    await buildReviewPacket(db, google, id); // idempotent per version
    const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM review_packets`);
    expect(rows[0]!.n).toBe(1);
  });

  it('throws when there is no review_ready artifact', async () => {
    const c = await db.query<{ id: string }>(
      `INSERT INTO courses (name, source, source_id) VALUES ('C','canvas','c2') RETURNING id`,
    );
    const a = await db.query<{ id: string }>(
      `INSERT INTO assignments (course_id, title, source, source_id) VALUES ($1,'X','canvas','a2') RETURNING id`,
      [c.rows[0]!.id],
    );
    await expect(buildReviewPacket(db, google, a.rows[0]!.id)).rejects.toThrow(/no review_ready/);
  });
});

describe('getReviewPacket', () => {
  it('returns the stored packet', async () => {
    const id = await reviewReadyAssignment();
    await buildReviewPacket(db, google, id);
    const stored = await getReviewPacket(db, id);
    expect(stored?.assignment_id).toBe(id);
  });
});

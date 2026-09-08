import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { computeStyleFeatures } from '../../src/writing/features.js';
import { addWritingSample, buildStyleProfile, recordEditSignal } from '../../src/writing/profile.js';
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

async function course(sid: string): Promise<string> {
  const c = await db.query<{ id: string }>(
    `INSERT INTO courses (name, source, source_id) VALUES ('C','canvas',$1) RETURNING id`,
    [sid],
  );
  return c.rows[0]!.id;
}

const LONG = 'This is a considerably longer and more formal sentence that continues for quite a while without stopping.';
const SHORT = 'Short. Punchy. Done.';

describe('computeStyleFeatures', () => {
  it('measures longer sentences as higher avg length', () => {
    expect(computeStyleFeatures(LONG).avg_sentence_len).toBeGreaterThan(
      computeStyleFeatures(SHORT).avg_sentence_len,
    );
  });
});

describe('buildStyleProfile weighting', () => {
  it('weighs course-matching samples more heavily', async () => {
    const target = await course('c1');
    const other = await course('c2');
    await addWritingSample(db, { source: 'instructor', text: LONG, courseId: target });
    await addWritingSample(db, { source: 'instructor', text: SHORT, courseId: other });

    const profile = await buildStyleProfile(db, { courseId: target });
    // Target-course (LONG) is weighted 2x, so the profile leans long.
    const midpoint =
      (computeStyleFeatures(LONG).avg_sentence_len + computeStyleFeatures(SHORT).avg_sentence_len) / 2;
    expect(profile.features.avg_sentence_len).toBeGreaterThan(midpoint);
  });
});

describe('no over-learning from a single edit', () => {
  it('a lone edit signal only nudges the profile', async () => {
    const c = await course('c1');
    // Five established long-form samples.
    for (let i = 0; i < 5; i += 1) {
      await addWritingSample(db, { source: 'instructor', text: LONG, courseId: c });
    }
    const before = (await buildStyleProfile(db, { courseId: c })).features.avg_sentence_len;

    // One short edit signal (low weight).
    await recordEditSignal(db, { text: SHORT, courseId: c });
    const after = (await buildStyleProfile(db, { courseId: c })).features.avg_sentence_len;

    const shortLen = computeStyleFeatures(SHORT).avg_sentence_len;
    // Moved toward short, but nowhere near it (bounded influence).
    expect(after).toBeLessThan(before);
    expect(after - shortLen).toBeGreaterThan((before - shortLen) * 0.8);
  });
});

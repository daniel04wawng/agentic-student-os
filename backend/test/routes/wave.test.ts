import type { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import type { SqlClient } from '../../src/db/client.js';
import { draftDiscussion } from '../../src/discussions/service.js';
import { FakeModelProvider } from '../../src/model/provider.js';
import { ModelService } from '../../src/model/service.js';
import { buildServer } from '../../src/server.js';
import { InMemoryStorageProvider } from '../../src/storage/provider.js';
import { freshDb, insertCourse, resetDb } from '../db/helpers.js';

/**
 * End-to-end HTTP test of this build wave through the REAL Fastify server (the
 * exact request/response the iOS app makes): editable drafts, lecture-session
 * matching, the sessions picker, and the chat endpoint. Uses a fake model + fake
 * storage so no external services are touched.
 */

let db: PGlite;
let app: FastifyInstance;
const canvasAuth = { baseUrl: 'https://canvas.test', token: 't' };

/** now() and a class window around it, so /sessions and time-matching both hit. */
const now = new Date();
const iso = (offsetMin: number): string => new Date(now.getTime() + offsetMin * 60_000).toISOString();

beforeAll(async () => {
  db = await freshDb();
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await resetDb(db);
  const chatModel = new ModelService(new FakeModelProvider(() => 'Penetration pricing sets a low entry price [M1].'));
  app = buildServer(loadConfig({ LOG_LEVEL: 'fatal' }), {
    db,
    storage: new InMemoryStorageProvider(),
    model: chatModel,
    canvasAuth,
  });
  await app.ready();
});
afterEach(async () => {
  await app.close();
});

async function seedSession(courseId: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO sessions (course_id, title, starts_at, ends_at) VALUES ($1,'Class Today',$2,$3) RETURNING id`,
    [courseId, iso(0), iso(90)],
  );
  return rows[0]!.id;
}

async function seedDraftedDiscussion(courseId: string): Promise<{ assignmentId: string; artifactId: string }> {
  const a = await db.query<{ id: string }>(
    `INSERT INTO assignments (course_id, title, description, status, source, source_id, metadata)
     VALUES ($1,'DP2','Answer the prep.','not_started','canvas','discussion:555',
             jsonb_build_object('type','discussion','discussion_id',555))
     RETURNING id`,
    [courseId],
  );
  const assignmentId = a.rows[0]!.id;
  const seedModel = new ModelService(new FakeModelProvider(() => JSON.stringify({ post: 'ORIGINAL DRAFT' })));
  const { artifactId } = await draftDiscussion(db as unknown as SqlClient, seedModel, assignmentId);
  return { assignmentId, artifactId };
}

describe('build wave HTTP routes', () => {
  it('GET /sessions returns sessions around now', async () => {
    const courseId = await insertCourse(db, 'Strategy');
    const sid = await seedSession(courseId);
    const res = await app.inject({ method: 'GET', url: '/sessions' });
    expect(res.statusCode).toBe(200);
    expect(res.json().some((s: { id: string }) => s.id === sid)).toBe(true);
  });

  it('POST /recordings auto-links to the current class; PUT /recordings/:id/session overrides', async () => {
    const courseId = await insertCourse(db, 'Strategy');
    const sid = await seedSession(courseId);

    const reg = await app.inject({
      method: 'POST',
      url: '/recordings',
      payload: { client_id: 'rec-x', captured_at: iso(3), duration_ms: 1000 },
    });
    expect(reg.statusCode).toBe(200);
    const recId = reg.json().id;
    const linked = await db.query<{ session_id: string | null }>(`SELECT session_id FROM recordings WHERE id=$1`, [recId]);
    expect(linked.rows[0]!.session_id).toBe(sid);

    // Override to unlink.
    const put = await app.inject({ method: 'PUT', url: `/recordings/${recId}/session`, payload: { session_id: null } });
    expect(put.statusCode).toBe(200);
    const after = await db.query<{ session_id: string | null }>(`SELECT session_id FROM recordings WHERE id=$1`, [recId]);
    expect(after.rows[0]!.session_id).toBeNull();
  });

  it('POST /chat answers with sources from the student materials', async () => {
    const courseId = await insertCourse(db, 'Marketing');
    await db.query(
      `INSERT INTO materials (course_id, kind, title, text, source, source_id)
       VALUES ($1,'case','Keystone Pricing Case','Penetration pricing versus skimming strategy.','canvas','k1')`,
      [courseId],
    );
    const res = await app.inject({ method: 'POST', url: '/chat', payload: { question: 'what is penetration pricing?' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().answer).toContain('Penetration pricing');
    expect(res.json().sources.some((s: { title: string }) => s.title === 'Keystone Pricing Case')).toBe(true);
  });

  it('PUT /assignments/:id/draft edits text and forces re-approval before submit', async () => {
    const courseId = await insertCourse(db, 'Programming');
    await db.query(`UPDATE courses SET source='canvas', source_id='1' WHERE id=$1`, [courseId]);
    const { assignmentId, artifactId } = await seedDraftedDiscussion(courseId);

    // Approve the original draft.
    const approve = await app.inject({ method: 'POST', url: `/artifacts/${artifactId}/approve` });
    expect(approve.statusCode).toBe(200);
    let draft = await app.inject({ method: 'GET', url: `/assignments/${assignmentId}/draft` });
    expect(draft.json().approved).toBe(true);

    // Edit the text: response reflects the new text and drops approval.
    const edit = await app.inject({
      method: 'PUT',
      url: `/assignments/${assignmentId}/draft`,
      payload: { text: 'REVISED ANSWER' },
    });
    expect(edit.statusCode).toBe(200);
    expect(edit.json().draft_text).toBe('REVISED ANSWER');
    expect(edit.json().approved).toBe(false);

    // Submit is refused (409) because the edited text was never approved.
    const submit = await app.inject({ method: 'POST', url: `/assignments/${assignmentId}/submit` });
    expect(submit.statusCode).toBe(409);

    // Re-approve the edited version -> approval reads true again.
    await app.inject({ method: 'POST', url: `/artifacts/${artifactId}/approve` });
    const check = await app.inject({ method: 'GET', url: `/artifacts/${artifactId}/approval` });
    expect(check.json().approved).toBe(true);
  });
});

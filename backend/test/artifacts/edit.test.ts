import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createGoogleDocArtifact } from '../../src/artifacts/registry.js';
import { safeAgentEdit } from '../../src/artifacts/edit.js';
import { FakeGoogleDocsClient } from '../../src/google/client.js';
import { freshDb, resetDb } from '../db/helpers.js';

let db: PGlite;
let google: FakeGoogleDocsClient;
beforeAll(async () => {
  db = await freshDb();
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await resetDb(db);
  google = new FakeGoogleDocsClient();
});

async function seedArtifact(content: string): Promise<{ artifactId: string; docId: string }> {
  const c = await db.query<{ id: string }>(
    `INSERT INTO courses (name, source, source_id) VALUES ('C','canvas','c1') RETURNING id`,
  );
  const a = await db.query<{ id: string }>(
    `INSERT INTO assignments (course_id, title, source, source_id) VALUES ($1,'A','canvas','a1') RETURNING id`,
    [c.rows[0]!.id],
  );
  const d = await db.query<{ id: string }>(
    `INSERT INTO deliverables (assignment_id, title) VALUES ($1,'D') RETURNING id`,
    [a.rows[0]!.id],
  );
  const { artifactId, docId } = await createGoogleDocArtifact(db, google, d.rows[0]!.id, 'Essay', content);
  return { artifactId, docId };
}

describe('safeAgentEdit', () => {
  it('applies an agent edit and advances the tracked revision (no user change)', async () => {
    const { artifactId, docId } = await seedArtifact('draft one');
    const res = await safeAgentEdit(db, google, artifactId, (c) => `${c} + agent`);
    expect(res.rebased).toBe(false);
    expect(await google.getContent(docId)).toBe('draft one + agent');
    const { rows } = await db.query<{ rv: string }>(
      `SELECT remote_version AS rv FROM artifacts WHERE id=$1`,
      [artifactId],
    );
    expect(rows[0]!.rv).toBe(res.revision);
  });

  it('NEVER overwrites a user edit: the agent rebases onto the user version', async () => {
    const { artifactId, docId } = await seedArtifact('agent draft');

    // User edits the doc out of band (revision bumps).
    await google.updateDoc(docId, 'IMPORTANT USER EDIT');

    const res = await safeAgentEdit(db, google, artifactId, (c) => `${c}\n[agent footnote]`);
    expect(res.rebased).toBe(true);

    const finalContent = await google.getContent(docId);
    // The user's text is preserved (never discarded) and the agent change is additive.
    expect(finalContent).toContain('IMPORTANT USER EDIT');
    expect(finalContent).toContain('[agent footnote]');
  });

  it('records the rebase flag in artifact metadata', async () => {
    const { artifactId, docId } = await seedArtifact('x');
    await google.updateDoc(docId, 'user changed it');
    await safeAgentEdit(db, google, artifactId, (c) => c);
    const { rows } = await db.query<{ rebased: boolean }>(
      `SELECT (metadata->>'last_rebased')::boolean AS rebased FROM artifacts WHERE id=$1`,
      [artifactId],
    );
    expect(rows[0]!.rebased).toBe(true);
  });
});

import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createGoogleDocArtifact,
  getArtifact,
  updateArtifactRemoteVersion,
} from '../../src/artifacts/registry.js';
import { FakeGoogleDocsClient, UnconfiguredGoogleDocsClient } from '../../src/google/client.js';
import { freshDb, resetDb } from '../db/helpers.js';

let db: PGlite;
const google = new FakeGoogleDocsClient();
beforeAll(async () => {
  db = await freshDb();
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await resetDb(db);
});

async function seedDeliverable(): Promise<string> {
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
  return d.rows[0]!.id;
}

describe('createGoogleDocArtifact', () => {
  it('registers an artifact with uri, doc id, and remote revision', async () => {
    const deliverableId = await seedDeliverable();
    const { artifactId, docId, uri } = await createGoogleDocArtifact(
      db,
      google,
      deliverableId,
      'Essay',
      'hello',
    );
    expect(uri).toContain(docId);
    const artifact = await getArtifact(db, artifactId);
    expect(artifact).toMatchObject({ kind: 'google_doc', status: 'draft', uri, remote_version: '1', version: 1 });

    const { rows } = await db.query<{ source: string; source_id: string }>(
      `SELECT source, source_id FROM artifacts WHERE id=$1`,
      [artifactId],
    );
    expect(rows[0]).toMatchObject({ source: 'google', source_id: docId });
  });
});

describe('updateArtifactRemoteVersion', () => {
  it('records a new remote revision', async () => {
    const deliverableId = await seedDeliverable();
    const { artifactId } = await createGoogleDocArtifact(db, google, deliverableId, 'E', 'x');
    await updateArtifactRemoteVersion(db, artifactId, '7');
    expect((await getArtifact(db, artifactId))!.remote_version).toBe('7');
  });
});

describe('UnconfiguredGoogleDocsClient', () => {
  it('fails clearly until OAuth is connected', async () => {
    await expect(new UnconfiguredGoogleDocsClient().createDoc('a', 'b')).rejects.toThrow(/not connected/);
  });
});

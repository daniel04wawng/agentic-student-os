import type { SqlClient } from '../db/client.js';
import type { GoogleDocsClient } from '../google/client.js';

export interface ArtifactRow {
  id: string;
  kind: string;
  status: string;
  uri: string | null;
  remote_version: string | null;
  version: number;
}

export async function getArtifact(db: SqlClient, artifactId: string): Promise<ArtifactRow | null> {
  const { rows } = await db.query<ArtifactRow>(
    `SELECT id, kind, status, uri, remote_version, version FROM artifacts WHERE id = $1`,
    [artifactId],
  );
  return rows[0] ?? null;
}

/** Record the latest known remote revision for an artifact. */
export async function updateArtifactRemoteVersion(
  db: SqlClient,
  artifactId: string,
  remoteVersion: string,
): Promise<void> {
  await db.query(`UPDATE artifacts SET remote_version = $2 WHERE id = $1`, [artifactId, remoteVersion]);
}

/**
 * Create a Google Doc and register it as an artifact, capturing its remote
 * doc id (source_id), URI, and revision id (remote_version) so later PRs can
 * detect out-of-band user edits.
 */
export async function createGoogleDocArtifact(
  db: SqlClient,
  google: GoogleDocsClient,
  deliverableId: string,
  title: string,
  content: string,
): Promise<{ artifactId: string; docId: string; uri: string }> {
  const doc = await google.createDoc(title, content);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO artifacts (deliverable_id, kind, status, uri, remote_version, version, source, source_id)
     VALUES ($1, 'google_doc', 'draft', $2, $3, 1, 'google', $4)
     RETURNING id`,
    [deliverableId, doc.uri, doc.revisionId, doc.id],
  );
  return { artifactId: rows[0]!.id, docId: doc.id, uri: doc.uri };
}

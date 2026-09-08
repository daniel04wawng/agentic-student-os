import type { SqlClient } from '../db/client.js';

export type PermissionPolicy = 'require_review' | 'auto';

/** Permission policy for an assignment. Defaults to require_review (safe). */
export async function getPermissionPolicy(db: SqlClient, assignmentId: string): Promise<PermissionPolicy> {
  const { rows } = await db.query<{ policy: string | null }>(
    `SELECT metadata->>'permission_policy' AS policy FROM assignments WHERE id = $1`,
    [assignmentId],
  );
  return rows[0]?.policy === 'auto' ? 'auto' : 'require_review';
}

/**
 * Approve the EXACT current version of an artifact. The approval is tied to the
 * artifact's remote_version, so any later modification (which advances
 * remote_version) leaves the approval stale.
 */
export async function approveArtifact(
  db: SqlClient,
  input: { assignmentId: string; artifactId: string; actor: string },
): Promise<{ approvalId: string; version: string }> {
  const art = await db.query<{ remote_version: string | null }>(
    `SELECT remote_version FROM artifacts WHERE id = $1`,
    [input.artifactId],
  );
  if (art.rows.length === 0) throw new Error(`artifact not found: ${input.artifactId}`);
  const version = art.rows[0]!.remote_version ?? '';

  // Supersede any prior active approval for this artifact.
  await db.query(
    `UPDATE approvals SET status='invalidated', invalidated_at=now(), reason='superseded'
     WHERE artifact_id=$1 AND status='active'`,
    [input.artifactId],
  );
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO approvals (assignment_id, artifact_id, remote_version, actor, status)
     VALUES ($1,$2,$3,$4,'active') RETURNING id`,
    [input.assignmentId, input.artifactId, version, input.actor],
  );
  return { approvalId: rows[0]!.id, version };
}

/**
 * Invalidate any active approval whose approved version no longer matches the
 * artifact's current remote_version (i.e. the artifact was modified after
 * approval). Returns how many approvals were invalidated.
 */
export async function invalidateStaleApprovals(db: SqlClient, artifactId: string): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    `UPDATE approvals ap
       SET status='invalidated', invalidated_at=now(), reason='post_approval_modification'
     FROM artifacts a
     WHERE ap.artifact_id = a.id
       AND ap.artifact_id = $1
       AND ap.status = 'active'
       AND ap.remote_version IS DISTINCT FROM a.remote_version
     RETURNING ap.id`,
    [artifactId],
  );
  return rows.length;
}

/** True when an ACTIVE approval exists for the artifact's current version. */
export async function isApproved(db: SqlClient, artifactId: string): Promise<boolean> {
  const { rows } = await db.query<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM approvals ap JOIN artifacts a ON a.id = ap.artifact_id
       WHERE ap.artifact_id = $1 AND ap.status='active'
         AND ap.remote_version IS NOT DISTINCT FROM a.remote_version
     ) AS ok`,
    [artifactId],
  );
  return rows[0]!.ok;
}

import { invalidateStaleApprovals } from '../approval/approval.js';
import type { SqlClient } from '../db/client.js';
import type { GoogleDocsClient } from '../google/client.js';

export interface SafeEditResult {
  /** True when the remote doc had changed since our last known revision. */
  rebased: boolean;
  revision: string;
}

/**
 * Apply an agent edit to a Google-Docs-backed artifact WITHOUT ever overwriting
 * the user's work.
 *
 * User-wins rule: the edit function always runs against the CURRENT remote
 * content, so any out-of-band user changes are the base the agent rebases onto.
 * If the remote revision differs from our last known revision, we flag a rebase
 * (provenance) and record it, but we still never replace the user's content —
 * we transform it. The stored remote_version is advanced to the new revision so
 * subsequent edits keep rebasing onto the latest.
 */
export async function safeAgentEdit(
  db: SqlClient,
  google: GoogleDocsClient,
  artifactId: string,
  editFn: (currentContent: string) => string,
): Promise<SafeEditResult> {
  const { rows } = await db.query<{ source_id: string | null; remote_version: string | null }>(
    `SELECT source_id, remote_version FROM artifacts WHERE id = $1`,
    [artifactId],
  );
  if (rows.length === 0 || !rows[0]!.source_id) {
    throw new Error(`artifact has no google doc: ${artifactId}`);
  }
  const docId = rows[0]!.source_id;
  const knownRevision = rows[0]!.remote_version;

  const currentRevision = await google.getRevision(docId);
  const rebased = knownRevision !== null && currentRevision !== knownRevision;

  // Always rebase the agent's change onto the live content (user text is the base).
  const currentContent = await google.getContent(docId);
  const merged = editFn(currentContent);
  const updated = await google.updateDoc(docId, merged);

  await db.query(
    `UPDATE artifacts
       SET remote_version = $2,
           metadata = metadata || jsonb_build_object('last_rebased', $3::boolean)
     WHERE id = $1`,
    [artifactId, updated.revisionId, rebased],
  );

  // Any post-approval modification invalidates the approval for the old version.
  await invalidateStaleApprovals(db, artifactId);

  return { rebased, revision: updated.revisionId };
}

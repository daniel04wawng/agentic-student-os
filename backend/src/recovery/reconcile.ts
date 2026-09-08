import { invalidateStaleApprovals } from '../approval/approval.js';
import type { SqlClient } from '../db/client.js';
import type { GoogleDocsClient } from '../google/client.js';

/**
 * Artifact reconciliation: detect out-of-band edits by comparing each Google
 * artifact's stored remote_version with the live revision. On drift, record it
 * and invalidate any stale approval (user edited outside the agent).
 */
export async function reconcileArtifacts(
  db: SqlClient,
  google: GoogleDocsClient,
): Promise<{ drifted: number }> {
  const { rows } = await db.query<{ id: string; source_id: string; remote_version: string | null }>(
    `SELECT id, source_id, remote_version FROM artifacts WHERE source='google' AND source_id IS NOT NULL`,
  );
  let drifted = 0;
  for (const art of rows) {
    const live = await google.getRevision(art.source_id);
    if (art.remote_version !== null && live !== art.remote_version) {
      drifted += 1;
      await db.query(
        `UPDATE artifacts SET remote_version = $2,
           metadata = metadata || jsonb_build_object('remote_drift', true) WHERE id = $1`,
        [art.id, live],
      );
      await invalidateStaleApprovals(db, art.id);
    }
  }
  return { drifted };
}

export interface StaleItem {
  table: string;
  id: string;
}

/**
 * Stale-state detection: items stuck in a transient state past a threshold are
 * candidates for recovery (they should be re-driven or surfaced).
 */
export async function detectStaleState(
  db: SqlClient,
  opts: { now: string; thresholdMinutes: number },
): Promise<StaleItem[]> {
  const cutoff = `($1::timestamptz - ($2 || ' minutes')::interval)`;
  const out: StaleItem[] = [];
  const checks: { table: string; column: string; value: string }[] = [
    { table: 'recordings', column: 'status', value: 'uploading' },
    { table: 'transcripts', column: 'status', value: 'processing' },
    { table: 'submissions', column: 'status', value: 'submitting' },
  ];
  for (const c of checks) {
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM ${c.table} WHERE ${c.column} = $3 AND updated_at < ${cutoff}`,
      [opts.now, String(opts.thresholdMinutes), c.value],
    );
    for (const r of rows) out.push({ table: c.table, id: r.id });
  }
  return out;
}

import type { SqlClient } from '../db/client.js';

export interface RecoverySnapshot {
  failed_recordings: number;
  failed_transcripts: number;
  failed_submissions: number;
  failed_notifications: number;
  dead_retries: number;
}

/** A snapshot of failed/dead work across the system for a recovery dashboard. */
export async function recoverySnapshot(db: SqlClient): Promise<RecoverySnapshot> {
  const one = async (sql: string): Promise<number> => {
    const { rows } = await db.query<{ n: number }>(sql);
    return rows[0]!.n;
  };
  return {
    failed_recordings: await one(`SELECT count(*)::int AS n FROM recordings WHERE status='failed'`),
    failed_transcripts: await one(`SELECT count(*)::int AS n FROM transcripts WHERE status='failed'`),
    failed_submissions: await one(`SELECT count(*)::int AS n FROM submissions WHERE status='failed'`),
    failed_notifications: await one(`SELECT count(*)::int AS n FROM notifications WHERE status='failed'`),
    dead_retries: await one(`SELECT count(*)::int AS n FROM retry_queue WHERE status='dead'`),
  };
}

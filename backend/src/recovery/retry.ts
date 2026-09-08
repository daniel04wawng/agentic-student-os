import type { SqlClient } from '../db/client.js';

export interface RetryItem {
  id: string;
  kind: string;
  subject_id: string | null;
  attempts: number;
}

/** Enqueue a recoverable operation for later retry. */
export async function enqueueRetry(
  db: SqlClient,
  input: { kind: string; subjectType?: string; subjectId?: string; maxAttempts?: number; error?: string },
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO retry_queue (kind, subject_type, subject_id, max_attempts, last_error)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [input.kind, input.subjectType ?? null, input.subjectId ?? null, input.maxAttempts ?? 5, input.error ?? null],
  );
  return rows[0]!.id;
}

/** Claim queued items whose next attempt is due. */
export async function claimDueRetries(db: SqlClient, now: string, limit = 50): Promise<RetryItem[]> {
  const { rows } = await db.query<RetryItem>(
    `SELECT id, kind, subject_id, attempts FROM retry_queue
     WHERE status='queued' AND next_attempt_at <= $1
     ORDER BY next_attempt_at LIMIT $2`,
    [now, limit],
  );
  return rows;
}

export async function completeRetry(db: SqlClient, id: string): Promise<void> {
  await db.query(`UPDATE retry_queue SET status='done' WHERE id=$1`, [id]);
}

/**
 * Record a failed attempt with backoff. When attempts reach max_attempts the
 * item is marked 'dead' (surfaced on the recovery dashboard, not lost).
 */
export async function failRetry(
  db: SqlClient,
  id: string,
  error: string,
  backoffSeconds = 60,
): Promise<'queued' | 'dead'> {
  const { rows } = await db.query<{ status: string }>(
    `UPDATE retry_queue
       SET attempts = attempts + 1,
           last_error = $2,
           next_attempt_at = now() + ($3 || ' seconds')::interval,
           status = CASE WHEN attempts + 1 >= max_attempts THEN 'dead'::retry_status ELSE 'queued'::retry_status END
     WHERE id = $1
     RETURNING status`,
    [id, error, String(backoffSeconds)],
  );
  return rows[0]!.status as 'queued' | 'dead';
}

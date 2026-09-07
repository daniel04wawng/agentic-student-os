import type { SqlClient } from '../db/client.js';
import type { NotificationKind } from '../db/schema.js';
import type { PushSender } from './push.js';

export interface DeviceInput {
  token: string;
  platform?: string;
  userRef?: string | null;
}

/** Register (or refresh) a device push token. Idempotent on token. */
export async function registerDevice(db: SqlClient, input: DeviceInput): Promise<string> {
  const res = await db.query<{ id: string }>(
    `INSERT INTO devices (token, platform, user_ref)
     VALUES ($1, $2, $3)
     ON CONFLICT (token) DO UPDATE
       SET platform = excluded.platform,
           user_ref = COALESCE(excluded.user_ref, devices.user_ref),
           last_seen_at = now()
     RETURNING id`,
    [input.token, input.platform ?? 'ios', input.userRef ?? null],
  );
  return res.rows[0]!.id;
}

export interface CreateNotificationInput {
  kind: NotificationKind;
  title: string;
  body?: string | null;
  subjectType?: string | null;
  subjectId?: string | null;
  dedupKey?: string | null;
}

/**
 * Create a notification-worthy item. Idempotent when a dedupKey is provided:
 * the same underlying thing never yields two notifications. Returns the id
 * (new or existing).
 */
export async function createNotification(
  db: SqlClient,
  input: CreateNotificationInput,
): Promise<string> {
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO notifications (kind, title, body, subject_type, subject_id, dedup_key)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (dedup_key) WHERE dedup_key IS NOT NULL DO NOTHING
     RETURNING id`,
    [
      input.kind,
      input.title,
      input.body ?? null,
      input.subjectType ?? null,
      input.subjectId ?? null,
      input.dedupKey ?? null,
    ],
  );
  if (inserted.rows.length > 0) return inserted.rows[0]!.id;

  const existing = await db.query<{ id: string }>(
    `SELECT id FROM notifications WHERE dedup_key = $1`,
    [input.dedupKey],
  );
  return existing.rows[0]!.id;
}

export interface DispatchResult {
  delivered: number;
  failed: number;
  skipped: number;
}

/**
 * Attempt push delivery for every not-yet-delivered notification. Delivery is
 * best-effort: on success the row is marked delivered; on failure it is marked
 * failed (attempts++/last_error) but PRESERVED so the in-app item is never lost
 * and can be retried; with no devices it stays pending. `status` transitions
 * never delete or hide the underlying record.
 */
export async function dispatchPending(db: SqlClient, sender: PushSender): Promise<DispatchResult> {
  const devices = await db.query<{ token: string; platform: string }>(
    `SELECT token, platform FROM devices`,
  );
  const pending = await db.query<{ id: string; title: string; body: string | null }>(
    `SELECT id, title, body FROM notifications WHERE status IN ('pending', 'failed') ORDER BY created_at`,
  );

  let delivered = 0;
  let failed = 0;
  let skipped = 0;

  for (const n of pending.rows) {
    if (devices.rows.length === 0) {
      skipped += 1; // no device to deliver to; item stays pending, not lost
      continue;
    }
    let ok = false;
    let lastError: string | null = null;
    for (const d of devices.rows) {
      try {
        await sender.send({ token: d.token, platform: d.platform }, { title: n.title, body: n.body });
        ok = true;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }
    if (ok) {
      await db.query(`UPDATE notifications SET status='delivered', delivered_at=now() WHERE id=$1`, [n.id]);
      delivered += 1;
    } else {
      await db.query(
        `UPDATE notifications
           SET status='failed', delivery_attempts = delivery_attempts + 1, last_error = $2
         WHERE id = $1`,
        [n.id, lastError],
      );
      failed += 1;
    }
  }

  return { delivered, failed, skipped };
}

/** Dismiss a notification (user acted on it). Idempotent. */
export async function dismissNotification(db: SqlClient, id: string): Promise<void> {
  await db.query(
    `UPDATE notifications SET status='dismissed', dismissed_at=now() WHERE id=$1 AND status <> 'dismissed'`,
    [id],
  );
}

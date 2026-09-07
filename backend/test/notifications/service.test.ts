import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createNotification,
  dismissNotification,
  dispatchPending,
  registerDevice,
} from '../../src/notifications/service.js';
import { NoopPushSender, type PushSender } from '../../src/notifications/push.js';
import { freshDb, resetDb } from '../db/helpers.js';

class FailingSender implements PushSender {
  async send(): Promise<void> {
    throw new Error('APNs unavailable');
  }
}

let db: PGlite;
beforeAll(async () => {
  db = await freshDb();
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await resetDb(db);
});

async function statusOf(id: string): Promise<{ status: string; attempts: number; err: string | null }> {
  const { rows } = await db.query<{ status: string; attempts: number; err: string | null }>(
    `SELECT status, delivery_attempts AS attempts, last_error AS err FROM notifications WHERE id=$1`,
    [id],
  );
  return rows[0]!;
}
async function count(table: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
  return rows[0]!.n;
}

describe('registerDevice', () => {
  it('is idempotent on token', async () => {
    await registerDevice(db, { token: 'tok-1' });
    await registerDevice(db, { token: 'tok-1' });
    expect(await count('devices')).toBe(1);
  });
});

describe('createNotification', () => {
  it('dedups on dedup_key', async () => {
    const a = await createNotification(db, { kind: 'info', title: 'Hi', dedupKey: 'k1' });
    const b = await createNotification(db, { kind: 'info', title: 'Hi again', dedupKey: 'k1' });
    expect(a).toBe(b);
    expect(await count('notifications')).toBe(1);
  });

  it('creates distinct rows without a dedup_key', async () => {
    await createNotification(db, { kind: 'info', title: 'A' });
    await createNotification(db, { kind: 'info', title: 'B' });
    expect(await count('notifications')).toBe(2);
  });
});

describe('dispatchPending', () => {
  it('marks delivered on success', async () => {
    await registerDevice(db, { token: 'tok-1' });
    const id = await createNotification(db, { kind: 'review_ready', title: 'Review ready' });
    const res = await dispatchPending(db, new NoopPushSender());
    expect(res.delivered).toBe(1);
    expect((await statusOf(id)).status).toBe('delivered');
  });

  it('KEEPS the item when push fails (failed, not lost)', async () => {
    await registerDevice(db, { token: 'tok-1' });
    const id = await createNotification(db, { kind: 'deadline', title: 'Due soon' });
    const res = await dispatchPending(db, new FailingSender());
    expect(res.failed).toBe(1);

    const s = await statusOf(id);
    expect(s.status).toBe('failed');
    expect(s.attempts).toBe(1);
    expect(s.err).toContain('APNs unavailable');
    expect(await count('notifications')).toBe(1); // item still present in-app
  });

  it('leaves items pending when there is no device (never lost)', async () => {
    const id = await createNotification(db, { kind: 'info', title: 'No device yet' });
    const res = await dispatchPending(db, new NoopPushSender());
    expect(res.skipped).toBe(1);
    expect((await statusOf(id)).status).toBe('pending');
  });

  it('retries a previously failed item on a later dispatch', async () => {
    await registerDevice(db, { token: 'tok-1' });
    const id = await createNotification(db, { kind: 'info', title: 'Retry me' });
    await dispatchPending(db, new FailingSender());
    expect((await statusOf(id)).status).toBe('failed');
    await dispatchPending(db, new NoopPushSender());
    expect((await statusOf(id)).status).toBe('delivered');
  });
});

describe('dismissNotification', () => {
  it('marks the notification dismissed', async () => {
    const id = await createNotification(db, { kind: 'info', title: 'x' });
    await dismissNotification(db, id);
    expect((await statusOf(id)).status).toBe('dismissed');
  });
});

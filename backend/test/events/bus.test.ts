import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { EventEnvelope } from '@student-os/shared';
import { EventBus } from '../../src/events/bus.js';
import { currentTraceId } from '../../src/trace.js';
import { freshDb, resetDb } from '../db/helpers.js';

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

let keyCounter = 0;
function envelope(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    name: 'test.thing.happened',
    occurred_at: '2026-09-07T12:00:00.000Z',
    idempotency_key: `k-${(keyCounter += 1)}`,
    trace_id: randomUUID(),
    source: 'system',
    payload: { a: 1 },
    ...overrides,
  };
}

async function countEvents(): Promise<number> {
  const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM events`);
  return rows[0]!.n;
}

describe('EventBus.publish', () => {
  it('records a new event, runs its handler once, and stamps processed_at', async () => {
    const bus = new EventBus(db);
    let calls = 0;
    bus.on('test.thing.happened', () => {
      calls += 1;
    });

    const res = await bus.publish(envelope());
    expect(res.duplicate).toBe(false);
    expect(res.eventId).toBeTruthy();
    expect(calls).toBe(1);

    const { rows } = await db.query<{ processed: boolean }>(
      `SELECT processed_at IS NOT NULL AS processed FROM events WHERE id = $1`,
      [res.eventId],
    );
    expect(rows[0]!.processed).toBe(true);
    expect(await countEvents()).toBe(1);
  });

  it('is idempotent: duplicate delivery records once and dispatches once', async () => {
    const bus = new EventBus(db);
    let calls = 0;
    bus.on('test.thing.happened', () => {
      calls += 1;
    });

    const e = envelope({ idempotency_key: 'stable-key' });
    const first = await bus.publish(e);
    const second = await bus.publish(e); // same key, redelivered

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.eventId).toBeNull();
    expect(calls).toBe(1);
    expect(await countEvents()).toBe(1);
  });

  it('rejects a malformed envelope (no write, no dispatch)', async () => {
    const bus = new EventBus(db);
    await expect(bus.publish({ source: 'system' })).rejects.toThrow();
    expect(await countEvents()).toBe(0);
  });

  it('records an event with no registered handler (no throw)', async () => {
    const bus = new EventBus(db);
    const res = await bus.publish(envelope({ name: 'nobody.listening' }));
    expect(res.duplicate).toBe(false);
    expect(await countEvents()).toBe(1);
  });

  it('dispatches within the event trace scope', async () => {
    const bus = new EventBus(db);
    const traceId = randomUUID();
    let seen: string | undefined;
    bus.on('test.thing.happened', () => {
      seen = currentTraceId();
    });
    await bus.publish(envelope({ trace_id: traceId }));
    expect(seen).toBe(traceId);
  });

  it('round-trips the payload as jsonb', async () => {
    const bus = new EventBus(db);
    const res = await bus.publish(envelope({ payload: { nested: { x: [1, 2] }, flag: true } }));
    const { rows } = await db.query<{ payload: unknown }>(
      `SELECT payload FROM events WHERE id = $1`,
      [res.eventId],
    );
    expect(rows[0]!.payload).toEqual({ nested: { x: [1, 2] }, flag: true });
  });

  it('leaves processed_at NULL when a handler fails (recoverable state)', async () => {
    const bus = new EventBus(db);
    bus.on('test.thing.happened', () => {
      throw new Error('boom');
    });
    const e = envelope({ idempotency_key: 'fails' });
    await expect(bus.publish(e)).rejects.toThrow('boom');

    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM events WHERE processed_at IS NULL`,
    );
    expect(rows[0]!.n).toBe(1);

    // Re-delivery is still safe: dedups, does not re-run the failing handler.
    const again = await bus.publish(e);
    expect(again.duplicate).toBe(true);
  });
});

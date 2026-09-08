import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { classifyMessage } from '../../src/admin/classify.js';
import { draftReply, draftReplyTemplate, ingestOutlook } from '../../src/admin/ingest.js';
import { FakeOutlookClient, type OutlookMessage } from '../../src/outlook/client.js';
import { FakeModelProvider } from '../../src/model/provider.js';
import { ModelService } from '../../src/model/service.js';
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

const msg = (over: Partial<OutlookMessage>): OutlookMessage => ({
  id: 'm1',
  from: 'prof@uni.edu',
  subject: 'Hello',
  body: 'body',
  receivedAt: '2026-09-07T12:00:00Z',
  ...over,
});

describe('classifyMessage', () => {
  it('classifies by keywords', () => {
    expect(classifyMessage(msg({ subject: 'Reschedule our meeting' })).kind).toBe('scheduling');
    expect(classifyMessage(msg({ body: 'Your tuition payment is due' })).kind).toBe('payment');
    expect(classifyMessage(msg({ subject: 'Please fill this form' })).kind).toBe('form');
    expect(classifyMessage(msg({ subject: 'Notes', body: 'fyi' })).kind).toBe('email');
  });
});

describe('ingestOutlook', () => {
  it('creates admin_items from messages + events, idempotently', async () => {
    const client = new FakeOutlookClient(
      [msg({ id: 'm1', subject: 'Reschedule meeting' }), msg({ id: 'm2', subject: 'Tuition payment due' })],
      [{ id: 'e1', subject: 'Office hours', startsAt: '2026-09-08T15:00:00Z' }],
    );
    const res = await ingestOutlook(db, client);
    expect(res).toEqual({ messages: 2, events: 1 });

    const counts = await db.query<{ kind: string; n: number }>(
      `SELECT kind, count(*)::int AS n FROM admin_items GROUP BY kind ORDER BY kind`,
    );
    const map = Object.fromEntries(counts.rows.map((r) => [r.kind, r.n]));
    expect(map).toMatchObject({ scheduling: 2, payment: 1 });

    await ingestOutlook(db, client); // idempotent
    const total = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM admin_items`);
    expect(total.rows[0]!.n).toBe(3);
  });
});

describe('draftReply', () => {
  it('uses a deterministic template when the model is unusable', async () => {
    const model = new ModelService(new FakeModelProvider(() => 'not json'));
    const reply = await draftReply(model, msg({ subject: 'Question about HW3' }));
    expect(reply).toBe(draftReplyTemplate(msg({ subject: 'Question about HW3' })));
  });
});

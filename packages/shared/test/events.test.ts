import { describe, expect, it } from 'vitest';
import { EventEnvelopeSchema, deriveIdempotencyKey } from '../src/events.js';

const base = {
  name: 'canvas.assignment.discovered',
  occurred_at: '2026-09-07T12:00:00.000Z',
  idempotency_key: 'k1',
  trace_id: '00000000-0000-0000-0000-000000000000',
  source: 'canvas',
};

describe('EventEnvelopeSchema', () => {
  it('accepts a well-formed envelope and defaults payload to {}', () => {
    const parsed = EventEnvelopeSchema.parse(base);
    expect(parsed.payload).toEqual({});
  });

  it('rejects an unknown source, a bad trace uuid, and unknown keys', () => {
    expect(EventEnvelopeSchema.safeParse({ ...base, source: 'nope' }).success).toBe(false);
    expect(EventEnvelopeSchema.safeParse({ ...base, trace_id: 'x' }).success).toBe(false);
    expect(EventEnvelopeSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
  });

  it('requires a non-empty name and idempotency_key', () => {
    expect(EventEnvelopeSchema.safeParse({ ...base, name: '' }).success).toBe(false);
    expect(EventEnvelopeSchema.safeParse({ ...base, idempotency_key: '' }).success).toBe(false);
  });
});

describe('deriveIdempotencyKey', () => {
  it('is deterministic for the same parts', () => {
    expect(deriveIdempotencyKey(['a', 'b'])).toBe(deriveIdempotencyKey(['a', 'b']));
  });

  it('avoids delimiter collisions between different part boundaries', () => {
    expect(deriveIdempotencyKey(['a|b', 'c'])).not.toBe(deriveIdempotencyKey(['a', 'b|c']));
  });

  it('throws on empty parts', () => {
    expect(() => deriveIdempotencyKey([])).toThrow();
  });
});

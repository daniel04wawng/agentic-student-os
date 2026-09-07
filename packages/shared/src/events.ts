import { z } from 'zod';
import { PROVIDERS } from './provider.js';

/**
 * Normalized event envelope. Every event flowing through the bus has this
 * shape. `idempotency_key` makes duplicate delivery safe (the bus dedups on
 * it); `trace_id` correlates processing back to its origin; the envelope
 * describes a FACT that happened (`name` is past-tense-ish, e.g.
 * "canvas.assignment.discovered"), not a command.
 */
export const EventEnvelopeSchema = z
  .object({
    name: z.string().min(1),
    occurred_at: z.string().datetime({ offset: true }),
    idempotency_key: z.string().min(1),
    trace_id: z.string().uuid(),
    source: z.enum(PROVIDERS),
    subject_type: z.string().min(1).optional(),
    subject_id: z.string().uuid().optional(),
    payload: z.record(z.unknown()).default({}),
  })
  .strict();

export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

/**
 * Deterministic idempotency key from stable parts (e.g. event name + provider +
 * external id). Same inputs -> same key, so re-delivering the same fact dedups.
 * Parts are percent-encoded so the delimiter cannot collide.
 */
export function deriveIdempotencyKey(parts: readonly string[]): string {
  if (parts.length === 0) throw new Error('deriveIdempotencyKey requires at least one part');
  return parts.map((p) => encodeURIComponent(p)).join('|');
}

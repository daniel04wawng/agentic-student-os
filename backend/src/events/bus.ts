import { EventEnvelopeSchema, type EventEnvelope } from '@student-os/shared';
import type { SqlClient } from '../db/client.js';
import { runWithTrace } from '../trace.js';

export type EventHandler = (event: EventEnvelope) => Promise<void> | void;

export interface PublishResult {
  /** DB id of the newly recorded event, or null when this was a duplicate. */
  eventId: string | null;
  /** True when an event with the same idempotency key was already recorded. */
  duplicate: boolean;
}

/**
 * Replay-safe event bus.
 *
 * `publish` records the event with an INSERT ... ON CONFLICT (idempotency_key)
 * DO NOTHING, so re-delivering the same fact is a no-op that dispatches nothing.
 * Handlers run ONLY for a newly-recorded event, inside the event's trace scope,
 * and `processed_at` is stamped after they succeed. A handler failure propagates
 * and leaves `processed_at` NULL — an explicit recoverable state (retry is PR 3).
 */
export class EventBus {
  private readonly handlers = new Map<string, EventHandler[]>();

  constructor(private readonly db: SqlClient) {}

  /** Register a handler for an event name. Multiple handlers are allowed. */
  on(name: string, handler: EventHandler): void {
    const list = this.handlers.get(name) ?? [];
    list.push(handler);
    this.handlers.set(name, list);
  }

  async publish(input: unknown): Promise<PublishResult> {
    const event = EventEnvelopeSchema.parse(input); // throws on malformed payloads

    const recorded = await this.db.query<{ id: string }>(
      `INSERT INTO events
         (type, occurred_at, subject_type, subject_id, source, payload, idempotency_key, trace_id)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [
        event.name,
        event.occurred_at,
        event.subject_type ?? null,
        event.subject_id ?? null,
        event.source,
        JSON.stringify(event.payload),
        event.idempotency_key,
        event.trace_id,
      ],
    );

    // Duplicate delivery: already recorded, do not dispatch again.
    if (recorded.rows.length === 0) {
      return { eventId: null, duplicate: true };
    }

    const eventId = recorded.rows[0]!.id;
    const handlers = this.handlers.get(event.name) ?? [];

    await runWithTrace(async () => {
      for (const handler of handlers) {
        await handler(event);
      }
    }, event.trace_id);

    await this.db.query(`UPDATE events SET processed_at = now() WHERE id = $1`, [eventId]);
    return { eventId, duplicate: false };
  }
}

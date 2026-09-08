import type { SqlClient } from '../db/client.js';
import type { ModelService } from '../model/service.js';
import type { OutlookClient, OutlookMessage } from '../outlook/client.js';
import { classifyMessage } from './classify.js';

export interface IngestResult {
  messages: number;
  events: number;
}

/**
 * Ingest Outlook email + calendar into admin_items. Deterministic classification
 * drives the admin_item kind. Idempotent: dedup on (source, source_id) so
 * re-ingesting the same inbox never creates duplicate admin items.
 */
export async function ingestOutlook(db: SqlClient, client: OutlookClient): Promise<IngestResult> {
  const messages = await client.listMessages();
  for (const message of messages) {
    const { kind, actionable } = classifyMessage(message);
    await db.query(
      `INSERT INTO admin_items (kind, status, title, source, source_id, metadata)
       VALUES ($1::admin_kind, 'open', $2, 'outlook', $3,
               jsonb_build_object('from', $4::text, 'actionable', $5::boolean))
       ON CONFLICT (source, source_id) WHERE source_id IS NOT NULL
       DO UPDATE SET title = excluded.title, kind = excluded.kind,
                     metadata = admin_items.metadata || excluded.metadata`,
      [kind, message.subject, message.id, message.from, actionable],
    );
  }

  const events = await client.listEvents();
  for (const event of events) {
    await db.query(
      `INSERT INTO admin_items (kind, status, title, due_at, source, source_id)
       VALUES ('scheduling', 'open', $1, $2, 'outlook', $3)
       ON CONFLICT (source, source_id) WHERE source_id IS NOT NULL
       DO UPDATE SET title = excluded.title, due_at = excluded.due_at`,
      [event.subject, event.startsAt, event.id],
    );
  }

  return { messages: messages.length, events: events.length };
}

/** Deterministic templated reply (fallback / no-LLM path). */
export function draftReplyTemplate(message: OutlookMessage): string {
  return `Hi,\n\nThanks for your message regarding "${message.subject}". I will follow up shortly.\n\nBest regards`;
}

/**
 * Draft a reply. Uses the model when available, else a deterministic template.
 * NOTE: drafting only. Sending is a side effect gated by approval elsewhere.
 */
export async function draftReply(model: ModelService, message: OutlookMessage): Promise<string> {
  try {
    const res = await model.generate({
      messages: [
        { role: 'system', content: 'Draft a concise, polite email reply.' },
        { role: 'user', content: `${message.subject}\n\n${message.body}` },
      ],
    });
    const text = res.text.trim();
    return text.length > 0 && text !== 'not json' ? text : draftReplyTemplate(message);
  } catch {
    return draftReplyTemplate(message);
  }
}

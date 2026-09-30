import type { FastifyInstance, FastifyReply } from 'fastify';
import { z, type ZodTypeAny } from 'zod';
import type { SqlClient } from '../db/client.js';
import { approveArtifact, isApproved } from '../approval/approval.js';
import { dismissNotification, registerDevice } from '../notifications/service.js';
import { getReviewPacket } from '../review/packet.js';
import { submitDiscussion, updateDiscussionDraft } from '../discussions/service.js';
import { answerQuestion, buildChatContext } from '../chat/service.js';
import type { ModelService } from '../model/service.js';
import type { Embedder } from '../retrieval/embed.js';
import {
  getAssignmentDraft,
  getAssignments,
  getDeadlines,
  getLectures,
  getReview,
  getToday,
  getUpcomingPreps,
  listSessions,
} from '../views/queries.js';

/** Canvas credentials for the one write action exposed to the app: submit. */
export interface CanvasAuth {
  baseUrl: string;
  token: string;
}

/** Parse with a schema; on failure send 400 and return undefined. */
function parseOr400<S extends ZodTypeAny>(
  schema: S,
  value: unknown,
  reply: FastifyReply,
): z.infer<S> | undefined {
  const result = schema.safeParse(value);
  if (!result.success) {
    void reply.code(400).send({ error: 'invalid_request', issues: result.error.issues });
    return undefined;
  }
  return result.data;
}

/** Mount DB-backed read + notification routes. Requires a SqlClient. The
 * optional Canvas auth enables the submit route (posting an approved draft). */
export function registerApiRoutes(
  app: FastifyInstance,
  db: SqlClient,
  canvasAuth?: CanvasAuth,
  model?: ModelService,
  embedder?: Embedder,
): void {
  app.post('/devices', async (req, reply) => {
    const body = parseOr400(
      z.object({ token: z.string().min(1), platform: z.enum(['ios', 'web']).optional() }),
      req.body,
      reply,
    );
    if (!body) return reply;
    return { id: await registerDevice(db, body) };
  });

  app.get('/deadlines', async (req, reply) => {
    const q = parseOr400(
      z.object({
        tz: z.string().default('UTC'),
        horizon: z.coerce.number().int().positive().max(365).optional(),
      }),
      req.query,
      reply,
    );
    if (!q) return reply;
    return getDeadlines(db, {
      now: new Date().toISOString(),
      currentTimezone: q.tz,
      horizonDays: q.horizon,
    });
  });

  app.get('/today', async (req, reply) => {
    const q = parseOr400(z.object({ tz: z.string().default('UTC') }), req.query, reply);
    if (!q) return reply;
    return getToday(db, { now: new Date().toISOString(), currentTimezone: q.tz });
  });

  app.get('/review', async () => getReview(db));

  app.get('/preps', async () => getUpcomingPreps(db, { now: new Date().toISOString() }));

  app.get('/lectures', async () => getLectures(db));

  // Sessions around now, for the "which class is this lecture" override picker.
  app.get('/sessions', async () => listSessions(db));

  // Readable "textbook" view of the course primers (the OCR'd book), grouped
  // into chapters in reading order, so students can read the primers as text
  // instead of the source photos.
  app.get('/textbook', async () => {
    const { rows } = await db.query<{
      source_title: string | null;
      section: string | null;
      text: string;
    }>(
      `SELECT source_title, section, text FROM resource_chunks
       WHERE source_title IS NULL OR source_title NOT LIKE 'Session % schedule'
       ORDER BY chunk_index ASC, created_at ASC`,
    );
    // Normalize OCR primer titles ("Primer 87" -> "Primer 07"; single digit ->
    // zero-padded) and group chunks into chapters in first-seen (reading) order.
    const label = (t: string | null): string => {
      if (!t) return 'Primer';
      const m = /Primer\s+(\d{1,2})/i.exec(t);
      if (!m) return t.trim();
      let n = m[1]!;
      if (n.length === 2 && n[0] === '8') n = `0${n[1]}`;
      return `Primer ${n.padStart(2, '0')}`;
    };
    // Keep only section values that read like real headings (drop OCR fragments).
    const cleanHeading = (s: string | null): string | undefined => {
      if (!s) return undefined;
      const t = s.trim().replace(/\s+/g, ' ');
      if (t.length < 6 || t.length > 70) return undefined;
      if (!/^[A-Z]/.test(t) || !/\s/.test(t)) return undefined;
      if (/[),]$/.test(t) || /\d{3,}/.test(t)) return undefined;
      const letters = (t.match(/[A-Za-z]/g) ?? []).length;
      if (letters < t.length * 0.6) return undefined;
      return t;
    };

    interface Block {
      heading?: string;
      text: string;
    }
    const order: string[] = [];
    const byTitle = new Map<string, Block[]>();
    for (const r of rows) {
      const key = label(r.source_title);
      if (!byTitle.has(key)) {
        byTitle.set(key, []);
        order.push(key);
      }
      const blocks = byTitle.get(key)!;
      const heading = cleanHeading(r.section);
      if (heading) blocks.push({ heading, text: r.text });
      else if (blocks.length) blocks[blocks.length - 1]!.text += `\n\n${r.text}`;
      else blocks.push({ text: r.text });
    }
    // Numbered primers first (01..07), then special topics in reading order.
    const num = (t: string): number => {
      const m = /Primer\s+(\d+)/.exec(t);
      return m ? Number(m[1]) : Number.POSITIVE_INFINITY;
    };
    const firstSeen = new Map(order.map((t, i) => [t, i] as const));
    order.sort((a, b) => num(a) - num(b) || firstSeen.get(a)! - firstSeen.get(b)!);
    // Human topic per primer (students navigate by topic, not by number).
    const topics: Record<string, string> = {
      'Primer 01': 'What Macroeconomics Studies',
      'Primer 02': 'The Five Propositions',
      'Primer 03': 'Why We Measure GDP',
      'Primer 04': 'The Map Versus the Territory',
      'Primer 05': 'Labour Force & Hours',
      'Primer 06': 'What Drives Productivity',
      'Primer 07': 'Public Debt & Growth',
      'Special Topic': 'Tariffs & the Macroeconomy',
      'Special Topic (Tariffs)': 'Tariffs: The Full Accounting',
      'GMM Primer': 'Spending Over Time',
    };
    return {
      chapters: order.map((title) => ({
        title,
        topic: topics[title] ?? title,
        blocks: byTitle.get(title)!,
      })),
    };
  });

  // Study chat: ask a question, get an answer grounded in your own materials +
  // lectures. Requires a model; 503 when the backend has none configured.
  app.post('/chat', async (req, reply) => {
    const body = parseOr400(
      z.object({ question: z.string().min(1).max(2000), course_id: z.string().uuid().optional() }),
      req.body,
      reply,
    );
    if (!body) return reply;
    if (!model) return reply.code(503).send({ error: 'chat_unavailable' });
    return answerQuestion(db, model, { question: body.question, courseId: body.course_id, embedder });
  });

  // Streaming study chat (Server-Sent Events): emits `step` progress, a
  // `sources` event, then `token` deltas as the answer is generated, so the UI
  // can show it forming instead of a long silent wait. Falls back gracefully;
  // the non-streaming /chat above stays available.
  app.post('/chat/stream', async (req, reply) => {
    const body = parseOr400(
      z.object({ question: z.string().min(1).max(2000), course_id: z.string().uuid().optional() }),
      req.body,
      reply,
    );
    if (!body) return reply;
    if (!model) return reply.code(503).send({ error: 'chat_unavailable' });

    const raw = reply.raw;
    reply.hijack();
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const sse = (event: string, data: unknown): void => {
      if (!raw.writableEnded) raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    let closed = false;
    req.raw.on('close', () => {
      closed = true;
    });

    try {
      sse('step', { text: 'Searching your course materials' });
      const ctx = await buildChatContext(db, {
        question: body.question,
        courseId: body.course_id,
        embedder,
      });
      if (closed) return;
      sse('sources', { sources: ctx.sources });
      sse('step', {
        text: ctx.sources.length
          ? `Found ${ctx.sources.length} source${ctx.sources.length === 1 ? '' : 's'}, writing your answer`
          : 'No course match, answering from general knowledge',
      });

      let gotFirst = false;
      const heartbeat = setInterval(() => {
        if (!gotFirst && !closed) sse('step', { text: 'Waking the study model' });
      }, 5000);
      try {
        for await (const delta of model.generateStream({ messages: ctx.messages, maxTokens: 1000 })) {
          if (closed) break;
          gotFirst = true;
          sse('token', { delta });
        }
      } finally {
        clearInterval(heartbeat);
      }
      if (!closed) sse('done', {});
    } catch {
      if (!closed) sse('error', { message: 'The assistant is unavailable right now.' });
    } finally {
      if (!raw.writableEnded) raw.end();
    }
  });

  app.get('/assignments', async () => getAssignments(db));

  app.get('/assignments/:id/draft', async (req, reply) => {
    const p = parseOr400(z.object({ id: z.string().uuid() }), req.params, reply);
    if (!p) return reply;
    const draft = await getAssignmentDraft(db, p.id);
    if (!draft) return reply.code(404).send({ error: 'not_found' });
    return draft;
  });

  // Edit the drafted answer before approving/submitting. Advancing the text
  // invalidates any prior approval (submit then re-requires a fresh approval).
  app.put('/assignments/:id/draft', async (req, reply) => {
    const p = parseOr400(z.object({ id: z.string().uuid() }), req.params, reply);
    if (!p) return reply;
    const body = parseOr400(z.object({ text: z.string() }), req.body, reply);
    if (!body) return reply;
    const updated = await updateDiscussionDraft(db, p.id, body.text);
    if (!updated) return reply.code(404).send({ error: 'not_found' });
    const draft = await getAssignmentDraft(db, p.id);
    return draft ?? updated;
  });

  // Post an APPROVED draft to Canvas. The approval gate lives in submitDiscussion;
  // this never posts an un-approved or edited-since-approval draft.
  app.post('/assignments/:id/submit', async (req, reply) => {
    const p = parseOr400(z.object({ id: z.string().uuid() }), req.params, reply);
    if (!p) return reply;
    if (!canvasAuth) return reply.code(503).send({ error: 'submit_unavailable' });
    const result = await submitDiscussion(db, canvasAuth, p.id);
    if (result.status === 'refused') return reply.code(409).send(result);
    return result;
  });

  app.get('/assignments/:id/review-packet', async (req, reply) => {
    const params = parseOr400(z.object({ id: z.string().uuid() }), req.params, reply);
    if (!params) return reply;
    const packet = await getReviewPacket(db, params.id);
    if (!packet) return reply.code(404).send({ error: 'not_found' });
    return packet;
  });

  app.post('/artifacts/:id/approve', async (req, reply) => {
    const params = parseOr400(z.object({ id: z.string().uuid() }), req.params, reply);
    if (!params) return reply;
    const owner = await db.query<{ assignment_id: string }>(
      `SELECT d.assignment_id FROM artifacts a JOIN deliverables d ON d.id = a.deliverable_id WHERE a.id = $1`,
      [params.id],
    );
    if (owner.rows.length === 0 || !owner.rows[0]!.assignment_id) {
      return reply.code(404).send({ error: 'not_found' });
    }
    const result = await approveArtifact(db, {
      assignmentId: owner.rows[0]!.assignment_id,
      artifactId: params.id,
      actor: 'user',
    });
    return { approved: true, ...result };
  });

  app.get('/artifacts/:id/approval', async (req, reply) => {
    const params = parseOr400(z.object({ id: z.string().uuid() }), req.params, reply);
    if (!params) return reply;
    return { approved: await isApproved(db, params.id) };
  });

  app.post('/notifications/:id/dismiss', async (req, reply) => {
    const params = parseOr400(z.object({ id: z.string().uuid() }), req.params, reply);
    if (!params) return reply;
    await dismissNotification(db, params.id);
    return { ok: true };
  });
}

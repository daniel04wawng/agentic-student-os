import type { FastifyInstance, FastifyReply } from 'fastify';
import { z, type ZodTypeAny } from 'zod';
import type { SqlClient } from '../db/client.js';
import { approveArtifact, isApproved } from '../approval/approval.js';
import { dismissNotification, registerDevice } from '../notifications/service.js';
import { getReviewPacket } from '../review/packet.js';
import { submitDiscussion, updateDiscussionDraft } from '../discussions/service.js';
import { answerQuestion } from '../chat/service.js';
import type { ModelService } from '../model/service.js';
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
    return answerQuestion(db, model, { question: body.question, courseId: body.course_id });
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

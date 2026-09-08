import type { FastifyInstance, FastifyReply } from 'fastify';
import { z, type ZodTypeAny } from 'zod';
import type { SqlClient } from '../db/client.js';
import { dismissNotification, registerDevice } from '../notifications/service.js';
import { getReviewPacket } from '../review/packet.js';
import { getDeadlines, getReview, getToday } from '../views/queries.js';

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

/** Mount DB-backed read + notification routes. Requires a SqlClient. */
export function registerApiRoutes(app: FastifyInstance, db: SqlClient): void {
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

  app.get('/assignments/:id/review-packet', async (req, reply) => {
    const params = parseOr400(z.object({ id: z.string().uuid() }), req.params, reply);
    if (!params) return reply;
    const packet = await getReviewPacket(db, params.id);
    if (!packet) return reply.code(404).send({ error: 'not_found' });
    return packet;
  });

  app.post('/notifications/:id/dismiss', async (req, reply) => {
    const params = parseOr400(z.object({ id: z.string().uuid() }), req.params, reply);
    if (!params) return reply;
    await dismissNotification(db, params.id);
    return { ok: true };
  });
}

import Fastify, { type FastifyInstance } from 'fastify';
import { HealthResponseSchema, TRACE_HEADER, type HealthResponse } from '@student-os/shared';
import type { Config } from './config.js';
import { traceMixin } from './logger.js';
import { enterTraceContext, normalizeTraceId } from './trace.js';

const SERVICE_NAME = 'backend';
const VERSION = '0.0.0';

declare module 'fastify' {
  interface FastifyRequest {
    /** Normalized trace id for this request; the single source for header + body. */
    traceId: string;
  }
}

/**
 * Build the Fastify app. Kept separate from `listen` so tests can drive it via
 * `app.inject` without opening a socket. Fastify owns the pino instance; the
 * shared `traceMixin` injects the current trace id into every log line.
 */
export function buildServer(config: Config): FastifyInstance {
  const startedAt = process.hrtime.bigint();

  const app = Fastify({
    logger: { level: config.LOG_LEVEL, mixin: traceMixin },
  });

  app.decorateRequest('traceId', '');

  // Trace foundation: derive one trace id per request, store it on the request,
  // bind it to the async context (so all logs correlate), and echo it back.
  app.addHook('onRequest', async (request, reply) => {
    const traceId = normalizeTraceId(request.headers[TRACE_HEADER]);
    request.traceId = traceId;
    enterTraceContext(traceId);
    void reply.header(TRACE_HEADER, traceId);
  });

  app.get('/health', async (request): Promise<HealthResponse> => {
    const uptimeS = Number(process.hrtime.bigint() - startedAt) / 1e9;
    // Body trace_id comes from the SAME value echoed in the header (request.traceId),
    // so the two can never diverge. Validate output against the shared contract.
    return HealthResponseSchema.parse({
      status: 'ok',
      service: SERVICE_NAME,
      version: VERSION,
      trace_id: request.traceId,
      uptime_s: uptimeS,
    });
  });

  return app;
}

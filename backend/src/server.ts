import Fastify, { type FastifyInstance } from 'fastify';
import { HealthResponseSchema, TRACE_HEADER, type HealthResponse } from '@student-os/shared';
import type { Config } from './config.js';
import { currentTraceId, enterTraceContext, normalizeTraceId } from './trace.js';

const SERVICE_NAME = 'backend';
const VERSION = '0.0.0';

/**
 * Build the Fastify app. Kept separate from `listen` so tests can drive it via
 * `app.inject` without opening a socket. Fastify owns the pino instance; the
 * `mixin` injects the current trace id into every log line (see logger.ts for
 * the same mixin used outside the HTTP path).
 */
export function buildServer(config: Config): FastifyInstance {
  const startedAt = process.hrtime.bigint();

  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      mixin() {
        const traceId = currentTraceId();
        return traceId ? { trace_id: traceId } : {};
      },
    },
  });

  // Trace foundation: derive a trace id per request, bind it to the async
  // context (so all logs correlate), and echo it back to the caller.
  app.addHook('onRequest', async (request, reply) => {
    const traceId = normalizeTraceId(request.headers[TRACE_HEADER]);
    enterTraceContext(traceId);
    void reply.header(TRACE_HEADER, traceId);
  });

  app.get('/health', async (): Promise<HealthResponse> => {
    const uptimeS = Number(process.hrtime.bigint() - startedAt) / 1e9;
    // Validate our own output against the shared contract before returning.
    return HealthResponseSchema.parse({
      status: 'ok',
      service: SERVICE_NAME,
      version: VERSION,
      trace_id: currentTraceId() ?? normalizeTraceId(undefined),
      uptime_s: uptimeS,
    });
  });

  return app;
}

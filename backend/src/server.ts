import Fastify, { type FastifyInstance } from 'fastify';
import { HealthResponseSchema, TRACE_HEADER, type HealthResponse } from '@student-os/shared';
import type { Config } from './config.js';
import type { SqlClient } from './db/client.js';
import { registerInngest } from './inngest/serve.js';
import type { EventBus } from './events/bus.js';
import { registerApiRoutes } from './routes/api.js';
import { registerRecordingRoutes } from './routes/recordings.js';
import type { ModelService } from './model/service.js';
import type { StorageProvider } from './storage/provider.js';
import type { TranscriptionProvider } from './transcription/provider.js';
import { traceMixin } from './logger.js';
import { enterTraceContext, normalizeTraceId } from './trace.js';
import { extractBearer, verifySessionToken } from './auth/tokens.js';
import { registerAuthRoutes } from './routes/auth.js';

export interface ServerDeps {
  /** When provided, DB-backed read/notification routes are mounted. */
  db?: SqlClient;
  /** When provided alongside `db`, audio recording routes are mounted. */
  storage?: StorageProvider;
  /** When provided with storage + bus, uploaded audio is auto-transcribed. */
  transcription?: TranscriptionProvider;
  /** Event bus for pipeline events (e.g. transcription.completed). */
  bus?: EventBus;
  /** Canvas credentials; enables the submit route (posting an approved draft). */
  canvasAuth?: { baseUrl: string; token: string };
  /** Model service; enables the interactive chat route (/chat). */
  model?: ModelService;
  /** Secret for signing/verifying our own session tokens. When present, every
   * route except /health and /auth/* requires a valid bearer (request.userId is
   * set from its `sub`) and the /auth sign-in routes are mounted. Absent, the API
   * stays open (legacy single-user) so the backend can deploy before sign-in. */
  authJwtSecret?: string;
  /** Apple client id (bundle id) used as the identity-token audience. */
  appleClientId?: string;
}

const SERVICE_NAME = 'backend';
const VERSION = '0.0.0';

declare module 'fastify' {
  interface FastifyRequest {
    /** Normalized trace id for this request; the single source for header + body. */
    traceId: string;
    /** Authenticated Supabase user id (the JWT `sub`), when auth is enabled. */
    userId?: string;
  }
}

/** Paths that never require auth: health, the sign-in routes, and Inngest
 * (which has its own request signing). */
function isPublicPath(url: string): boolean {
  const path = url.split('?')[0] ?? url;
  return path === '/health' || path.startsWith('/auth/') || path.startsWith('/api/inngest');
}

/**
 * Build the Fastify app. Kept separate from `listen` so tests can drive it via
 * `app.inject` without opening a socket. Fastify owns the pino instance; the
 * shared `traceMixin` injects the current trace id into every log line.
 */
export function buildServer(config: Config, deps: ServerDeps = {}): FastifyInstance {
  const startedAt = process.hrtime.bigint();

  const app = Fastify({
    logger: { level: config.LOG_LEVEL, mixin: traceMixin },
  });

  app.decorateRequest('traceId', '');
  app.decorateRequest('userId', undefined);

  // Mount the Inngest serve endpoint only when configured, so an unconfigured
  // backend has no /api/inngest route returning errors.
  if (config.INNGEST_DEV || config.INNGEST_SIGNING_KEY) {
    registerInngest(app);
  }

  // DB-backed read + notification routes, mounted only when a client is provided.
  if (deps.db) {
    registerApiRoutes(app, deps.db, deps.canvasAuth, deps.model);
    // Sign-in routes, mounted only when auth is configured.
    if (deps.authJwtSecret) {
      registerAuthRoutes(app, deps.db, {
        jwtSecret: deps.authJwtSecret,
        appleClientId: deps.appleClientId ?? 'com.danielwang.studentos',
      });
    }
    if (deps.storage) {
      registerRecordingRoutes(app, deps.db, deps.storage, {
        transcription: deps.transcription,
        bus: deps.bus,
        model: deps.model,
      });
    }
  }

  // Trace foundation: derive one trace id per request, store it on the request,
  // bind it to the async context (so all logs correlate), and echo it back.
  app.addHook('onRequest', async (request, reply) => {
    const traceId = normalizeTraceId(request.headers[TRACE_HEADER]);
    request.traceId = traceId;
    enterTraceContext(traceId);
    void reply.header(TRACE_HEADER, traceId);
  });

  // Auth: when a Supabase JWT secret is configured, require a valid bearer token
  // on every non-public route and expose the user id as request.userId. Runs
  // after the trace hook so 401s are still traced. No secret -> API stays open.
  const jwtSecret = deps.authJwtSecret;
  if (jwtSecret) {
    app.addHook('onRequest', async (request, reply) => {
      if (isPublicPath(request.url)) return;
      const token = extractBearer(request.headers['authorization']);
      if (!token) {
        void reply.code(401).send({ error: 'unauthorized', reason: 'missing bearer token' });
        return reply;
      }
      try {
        request.userId = verifySessionToken(token, jwtSecret, 'access').userId;
      } catch (err) {
        void reply.code(401).send({ error: 'unauthorized', reason: err instanceof Error ? err.message : 'invalid token' });
        return reply;
      }
    });
  }

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

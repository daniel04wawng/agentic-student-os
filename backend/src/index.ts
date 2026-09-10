import { existsSync } from 'node:fs';
import pg from 'pg';
import { DirectCanvasClient } from './canvas/client.js';
import { loadConfig } from './config.js';
import type { SqlClient } from './db/client.js';
import { EventBus } from './events/bus.js';
import { createModelProvider } from './model/factory.js';
import { ModelService } from './model/service.js';
import { registerCanvasProjectors } from './projections/canvas.js';
import { createTranscriptionProvider } from './transcription/factory.js';
import { startCanvasSync } from './scheduler/canvas-sync.js';
import { startPrepScheduler } from './scheduler/scheduler.js';
import { buildServer, type ServerDeps } from './server.js';
import { LocalStorageProvider } from './storage/provider.js';

/**
 * Load a local `.env` into process.env before reading config, so the documented
 * `cp .env.example .env` workflow actually takes effect (Node does not auto-load
 * `.env`). Best-effort: absence is fine, and real deploys inject env directly.
 */
function loadDotEnv(): void {
  if (existsSync('.env')) {
    process.loadEnvFile('.env');
  }
}

/** Transient connection errors worth one retry (Supabase pooler blips). */
function isTransientDbError(err: unknown): boolean {
  const code = (err as { code?: string; errors?: { code?: string }[] })?.code;
  const nested = (err as { errors?: { code?: string }[] })?.errors?.map((e) => e.code) ?? [];
  return [code, ...nested].some((c) => c === 'ETIMEDOUT' || c === 'ECONNRESET' || c === 'ENOTFOUND' || c === '57P01');
}

/**
 * Adapt a pg Pool to the narrow SqlClient interface. Tuned for a pooled Supabase
 * connection (keepAlive so idle sockets are not dropped, a bounded pool, and a
 * connect timeout), and retries a query once on a transient connection blip so a
 * single pooler hiccup does not surface as a 500 to the app.
 */
function makeDbClient(databaseUrl: string): SqlClient {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    keepAlive: true,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  });
  pool.on('error', () => {
    // Idle client errors are recovered by the pool; do not crash the process.
  });
  return {
    async query<T>(text: string, params?: unknown[]): Promise<{ rows: T[] }> {
      try {
        const res = await pool.query(text, params as unknown[] | undefined);
        return { rows: res.rows as T[] };
      } catch (err) {
        if (!isTransientDbError(err)) throw err;
        const res = await pool.query(text, params as unknown[] | undefined);
        return { rows: res.rows as T[] };
      }
    },
  };
}

/** Process entrypoint. Fail fast on bad config before opening a socket. */
async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();
  const deps: ServerDeps = {};
  if (config.DATABASE_URL) {
    const db = makeDbClient(config.DATABASE_URL);
    deps.db = db;
    // Dev default: local filesystem blob store. Swap for S3/Supabase Storage
    // (presigned uploads) in production.
    deps.storage = new LocalStorageProvider(config.RECORDINGS_DIR);

    // Background pipelines: a bus with projectors turns ingest events into
    // canonical rows; Canvas sync keeps courses/deadlines/materials fresh; the
    // prep scheduler prepares upcoming classes ahead of time.
    const bus = new EventBus(db);
    registerCanvasProjectors(bus, db);
    deps.bus = bus;
    // Auto-transcribe uploaded audio (Deepgram when a key is set, else a fake).
    deps.transcription = createTranscriptionProvider(config);

    if (config.CANVAS_BASE_URL && config.CANVAS_API_TOKEN) {
      const canvas = new DirectCanvasClient({ baseUrl: config.CANVAS_BASE_URL, token: config.CANVAS_API_TOKEN });
      startCanvasSync(db, canvas, bus, {
        onTick: (r) => console.log('[canvas-sync]', JSON.stringify(r)),
      });
    }

    if (config.PREP_SCHEDULER) {
      const model = new ModelService(createModelProvider(config));
      startPrepScheduler(db, bus, model, {
        intervalMs: config.PREP_INTERVAL_MIN * 60_000,
        withinHours: config.PREP_WITHIN_HOURS,
        onTick: (r) => {
          if (r.prepared || r.error) console.log('[prep-scheduler]', JSON.stringify(r));
        },
      });
    }
  }
  const app = buildServer(config, deps);
  await app.listen({ port: config.BACKEND_PORT, host: config.BACKEND_HOST });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

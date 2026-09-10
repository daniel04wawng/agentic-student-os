import { existsSync } from 'node:fs';
import { DirectCanvasClient } from './canvas/client.js';
import { loadConfig } from './config.js';
import { makeDbClient } from './db/pool.js';
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

    // In-process schedulers (local/always-on hosting). Disabled with
    // PREP_SCHEDULER=0 when the loops run as external Modal scheduled functions
    // against a scale-to-zero web endpoint.
    if (config.PREP_SCHEDULER) {
      if (config.CANVAS_BASE_URL && config.CANVAS_API_TOKEN) {
        const canvas = new DirectCanvasClient({ baseUrl: config.CANVAS_BASE_URL, token: config.CANVAS_API_TOKEN });
        startCanvasSync(db, canvas, bus, {
          onTick: (r) => console.log('[canvas-sync]', JSON.stringify(r)),
        });
      }
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

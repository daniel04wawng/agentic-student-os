import { existsSync } from 'node:fs';
import pg from 'pg';
import { loadConfig } from './config.js';
import type { SqlClient } from './db/client.js';
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
    deps.db = makeDbClient(config.DATABASE_URL);
    // Dev default: local filesystem blob store. Swap for S3/Supabase Storage
    // (presigned uploads) in production.
    deps.storage = new LocalStorageProvider(config.RECORDINGS_DIR);
  }
  const app = buildServer(config, deps);
  await app.listen({ port: config.BACKEND_PORT, host: config.BACKEND_HOST });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

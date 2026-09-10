import pg from 'pg';
import type { SqlClient } from './client.js';

/** Transient connection errors worth one retry (Supabase pooler blips). */
function isTransientDbError(err: unknown): boolean {
  const code = (err as { code?: string; errors?: { code?: string }[] })?.code;
  const nested = (err as { errors?: { code?: string }[] })?.errors?.map((e) => e.code) ?? [];
  return [code, ...nested].some(
    (c) => c === 'ETIMEDOUT' || c === 'ECONNRESET' || c === 'ENOTFOUND' || c === '57P01',
  );
}

/**
 * Adapt a pg Pool to the narrow SqlClient interface. Tuned for a pooled Supabase
 * connection (keepAlive so idle sockets are not dropped, a bounded pool, and a
 * connect timeout), and retries a query once on a transient connection blip so a
 * single pooler hiccup does not surface as a 500.
 */
export function makeDbClient(databaseUrl: string): SqlClient {
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

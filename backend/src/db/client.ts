/**
 * Minimal SQL client interface the app depends on, instead of a concrete driver.
 * Satisfied by PGlite (tests) and node-postgres `Pool` (later, in prod), so the
 * event bus and future data access are decoupled from the provider.
 */
export interface SqlClient {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

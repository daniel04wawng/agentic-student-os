import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/**
 * Trace-context propagation foundation.
 *
 * A `trace_id` is bound to an AsyncLocalStorage store for the lifetime of a
 * request (or, later, an event handler). The logger reads it automatically so
 * every log line emitted while handling a unit of work carries the same id.
 * This is the seed of the "all state transitions are traceable" invariant.
 */
interface TraceStore {
  traceId: string;
}

const storage = new AsyncLocalStorage<TraceStore>();

/** Run `fn` within a trace scope. Reuses `traceId` if provided, else mints one. */
export function runWithTrace<T>(fn: () => T, traceId: string = randomUUID()): T {
  return storage.run({ traceId }, fn);
}

/**
 * Bind `traceId` to the CURRENT async execution context and all its children,
 * without a callback boundary. Used by the HTTP request hook where the
 * remainder of the request (handler + logging) runs in the same async chain.
 */
export function enterTraceContext(traceId: string): void {
  storage.enterWith({ traceId });
}

/** Current trace id, or `undefined` when called outside a trace scope. */
export function currentTraceId(): string | undefined {
  return storage.getStore()?.traceId;
}

/** Validate an inbound trace id; only accept a well-formed UUID, else mint one. */
export function normalizeTraceId(incoming: unknown): string {
  if (typeof incoming === 'string' && UUID_RE.test(incoming)) return incoming;
  return randomUUID();
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

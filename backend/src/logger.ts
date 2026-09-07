import { pino, type DestinationStream, type Logger } from 'pino';
import { currentTraceId } from './trace.js';

/**
 * pino `mixin` that injects the current trace id (if any) into every log line.
 * Single source of truth: both `createLogger` (non-HTTP paths) and the Fastify
 * logger options in server.ts use this, so HTTP and event logs stay consistent.
 */
export function traceMixin(): Record<string, string> {
  const traceId = currentTraceId();
  return traceId ? { trace_id: traceId } : {};
}

/**
 * Structured JSON logger. Level comes from config; a destination can be injected
 * for tests. The `mixin` correlates logs by trace id without threading it
 * through call sites.
 */
export function createLogger(level: string, destination?: DestinationStream): Logger {
  const options = { level, mixin: traceMixin };
  return destination ? pino(options, destination) : pino(options);
}

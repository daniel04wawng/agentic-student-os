import { pino, type DestinationStream, type Logger } from 'pino';
import { currentTraceId } from './trace.js';

/**
 * Structured JSON logger. A `mixin` injects the current trace id (if any) into
 * every line, so logs are correlatable without threading the id through call
 * sites. Level comes from config; default is set by the caller.
 */
export function createLogger(level: string, destination?: DestinationStream): Logger {
  const options = {
    level,
    mixin() {
      const traceId = currentTraceId();
      return traceId ? { trace_id: traceId } : {};
    },
  };
  return destination ? pino(options, destination) : pino(options);
}

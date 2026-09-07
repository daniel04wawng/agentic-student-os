import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/logger.js';
import { currentTraceId, runWithTrace } from '../src/trace.js';

describe('trace context', () => {
  it('exposes the bound trace id inside the scope and nothing outside', () => {
    expect(currentTraceId()).toBeUndefined();
    runWithTrace(() => {
      expect(currentTraceId()).toBe('abc');
    }, 'abc');
    expect(currentTraceId()).toBeUndefined();
  });

  it('injects trace_id into every log line emitted within the scope', () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });
    const logger = createLogger('info', sink);

    runWithTrace(() => {
      logger.info('first');
      logger.info('second');
    }, 'trace-xyz');

    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed).toHaveLength(2);
    expect(parsed.every((p) => p.trace_id === 'trace-xyz')).toBe(true);
  });
});

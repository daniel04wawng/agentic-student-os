import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HealthResponseSchema, TRACE_HEADER } from '../src/health.js';
import { OUT_DIR, renderSchemas } from '../scripts/generate-json-schema.js';

describe('HealthResponseSchema', () => {
  it('accepts a well-formed payload', () => {
    const ok = HealthResponseSchema.safeParse({
      status: 'ok',
      service: 'backend',
      version: '0.0.0',
      trace_id: '00000000-0000-0000-0000-000000000000',
      uptime_s: 1.2,
    });
    expect(ok.success).toBe(true);
  });

  it('rejects a non-uuid trace_id and unknown keys', () => {
    expect(
      HealthResponseSchema.safeParse({
        status: 'ok',
        service: 'backend',
        version: '0.0.0',
        trace_id: 'not-a-uuid',
        uptime_s: 0,
      }).success,
    ).toBe(false);

    expect(
      HealthResponseSchema.safeParse({
        status: 'ok',
        service: 'backend',
        version: '0.0.0',
        trace_id: '00000000-0000-0000-0000-000000000000',
        uptime_s: 0,
        extra: true,
      }).success,
    ).toBe(false);
  });

  it('exposes a stable trace header constant', () => {
    expect(TRACE_HEADER).toBe('x-trace-id');
  });
});

describe('json-schema generation', () => {
  it('is deterministic across two runs', () => {
    expect(renderSchemas()).toEqual(renderSchemas());
  });

  it('matches the committed generated file (regenerate if this fails)', () => {
    const onDisk = readFileSync(join(OUT_DIR, 'health-response.schema.json'), 'utf8');
    expect(onDisk).toBe(renderSchemas()['health-response']);
  });
});

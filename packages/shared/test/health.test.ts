import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HealthResponseSchema, TRACE_HEADER } from '../src/health.js';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

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
    const gen = () => {
      execFileSync('npm', ['run', 'generate'], { cwd: pkgRoot, stdio: 'pipe' });
      return readFileSync(join(pkgRoot, 'generated', 'health-response.schema.json'), 'utf8');
    };
    expect(gen()).toBe(gen());
  });
});

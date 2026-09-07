import { describe, expect, it } from 'vitest';
import { HealthResponseSchema, TRACE_HEADER } from '@student-os/shared';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';

const config = loadConfig({});

describe('GET /health', () => {
  it('returns a schema-valid ok payload and echoes a trace id header', async () => {
    const app = buildServer({ ...config, LOG_LEVEL: 'fatal' });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    const parsed = HealthResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    expect(body.status).toBe('ok');
    expect(body.service).toBe('backend');

    // trace id in the response header matches the one in the body.
    expect(res.headers[TRACE_HEADER]).toBe(body.trace_id);
    await app.close();
  });

  it('preserves a valid inbound trace id', async () => {
    const app = buildServer({ ...config, LOG_LEVEL: 'fatal' });
    const incoming = '11111111-1111-1111-1111-111111111111';
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { [TRACE_HEADER]: incoming },
    });
    expect(res.json().trace_id).toBe(incoming);
    expect(res.headers[TRACE_HEADER]).toBe(incoming);
    await app.close();
  });

  it('replaces a malformed inbound trace id with a fresh uuid', async () => {
    const app = buildServer({ ...config, LOG_LEVEL: 'fatal' });
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { [TRACE_HEADER]: 'garbage' },
    });
    expect(res.json().trace_id).not.toBe('garbage');
    expect(HealthResponseSchema.safeParse(res.json()).success).toBe(true);
    await app.close();
  });
});

import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { buildServer } from '../../src/server.js';

describe('Inngest serve endpoint gating', () => {
  it('is NOT mounted by default (no /api/inngest route)', async () => {
    const app = buildServer(loadConfig({ LOG_LEVEL: 'fatal' }));
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/api/inngest' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('is mounted when INNGEST_DEV is set', async () => {
    const app = buildServer(loadConfig({ LOG_LEVEL: 'fatal', INNGEST_DEV: '1' }));
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/api/inngest' });
    // Route exists (not 404). Whether it returns 200 vs 500 depends on dev/key
    // config, which is not exercised here; mounting is what we assert.
    expect(res.statusCode).not.toBe(404);
    await app.close();
  });
});

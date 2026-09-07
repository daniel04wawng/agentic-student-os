import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('applies defaults on an empty env', () => {
    const cfg = loadConfig({});
    expect(cfg.NODE_ENV).toBe('development');
    expect(cfg.BACKEND_PORT).toBe(3000);
    expect(cfg.LOG_LEVEL).toBe('info');
    // Loopback by default so the dev server is not exposed on the LAN.
    expect(cfg.BACKEND_HOST).toBe('127.0.0.1');
  });

  it('coerces a numeric port from a string', () => {
    expect(loadConfig({ BACKEND_PORT: '8080' }).BACKEND_PORT).toBe(8080);
  });

  it('throws a readable error on a malformed port', () => {
    expect(() => loadConfig({ BACKEND_PORT: 'not-a-number' })).toThrow(/BACKEND_PORT/);
  });

  it('throws on an out-of-range enum value', () => {
    expect(() => loadConfig({ LOG_LEVEL: 'loud' })).toThrow(/LOG_LEVEL/);
  });
});

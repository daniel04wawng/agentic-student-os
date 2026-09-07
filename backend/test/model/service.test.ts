import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { InMemoryInferenceCache } from '../../src/model/cache.js';
import { FakeModelProvider, ModelUnavailableError, type ModelRequest } from '../../src/model/provider.js';
import { ModelService, extractJson } from '../../src/model/service.js';

const req: ModelRequest = { messages: [{ role: 'user', content: 'hi' }] };
const schema = z.object({ answer: z.string() });

describe('extractJson', () => {
  it('pulls JSON out of fences and prose', () => {
    expect(extractJson('Here you go:\n```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJson('prefix {"a":1} suffix')).toBe('{"a":1}');
  });
});

describe('ModelService.generate caching', () => {
  it('skips the provider on a repeated identical request', async () => {
    const provider = new FakeModelProvider(() => 'result');
    const service = new ModelService(provider, { cache: new InMemoryInferenceCache() });
    const a = await service.generate(req);
    const b = await service.generate(req);
    expect(a.text).toBe('result');
    expect(b.text).toBe('result');
    expect(provider.callCount).toBe(1); // second served from cache
  });
});

describe('ModelService.generateStructured', () => {
  it('parses and validates a structured response', async () => {
    const provider = new FakeModelProvider(() => '```json\n{"answer":"42"}\n```');
    const service = new ModelService(provider);
    expect(await service.generateStructured(req, schema)).toEqual({ answer: '42' });
  });

  it('retries then uses the deterministic fallback on invalid output', async () => {
    const provider = new FakeModelProvider(() => 'not json at all');
    const service = new ModelService(provider);
    const result = await service.generateStructured(req, schema, {
      retries: 1,
      fallback: () => ({ answer: 'fallback' }),
    });
    expect(result).toEqual({ answer: 'fallback' });
    expect(provider.callCount).toBe(2); // initial + 1 retry
  });

  it('throws ModelUnavailableError when invalid and no fallback', async () => {
    const provider = new FakeModelProvider(() => 'garbage');
    const service = new ModelService(provider);
    await expect(service.generateStructured(req, schema)).rejects.toBeInstanceOf(ModelUnavailableError);
  });

  it('falls back when the provider throws (model unavailable)', async () => {
    const provider = new FakeModelProvider(() => {
      throw new Error('model down');
    });
    const service = new ModelService(provider);
    const result = await service.generateStructured(req, schema, { fallback: () => ({ answer: 'safe' }) });
    expect(result).toEqual({ answer: 'safe' });
  });

  it('caches a valid structured result across calls', async () => {
    const provider = new FakeModelProvider(() => '{"answer":"cached"}');
    const service = new ModelService(provider, { cache: new InMemoryInferenceCache() });
    await service.generateStructured(req, schema);
    await service.generateStructured(req, schema);
    expect(provider.callCount).toBe(1);
  });
});

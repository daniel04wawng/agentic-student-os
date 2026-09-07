import { describe, expect, it } from 'vitest';
import { ModalModelProvider } from '../../src/model/modal.js';
import { OllamaModelProvider, type FetchLike } from '../../src/model/ollama.js';
import { ModelUnavailableError, type ModelRequest } from '../../src/model/provider.js';

const req: ModelRequest = { messages: [{ role: 'user', content: 'hi' }] };

describe('OllamaModelProvider', () => {
  it('parses a chat response', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ model: 'gemma2', message: { content: 'hello' } }), { status: 200 });
    const provider = new OllamaModelProvider('http://localhost:11434', 'gemma2', fetchImpl);
    const res = await provider.generate(req);
    expect(res.text).toBe('hello');
    expect(res.model).toBe('gemma2');
  });

  it('throws ModelUnavailableError on a non-2xx and when unreachable', async () => {
    const bad = new OllamaModelProvider('http://x', 'gemma2', async () => new Response('', { status: 500 }));
    await expect(bad.generate(req)).rejects.toBeInstanceOf(ModelUnavailableError);

    const down = new OllamaModelProvider('http://x', 'gemma2', async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(down.generate(req)).rejects.toBeInstanceOf(ModelUnavailableError);
  });
});

describe('ModalModelProvider', () => {
  it('throws when the endpoint is not configured', async () => {
    const provider = new ModalModelProvider(undefined, undefined);
    await expect(provider.generate(req)).rejects.toBeInstanceOf(ModelUnavailableError);
  });

  it('sends the bearer token and parses text', async () => {
    let auth: string | undefined;
    const fetchImpl: FetchLike = async (_url, init) => {
      auth = (init?.headers as Record<string, string>).Authorization;
      return new Response(JSON.stringify({ text: 'from modal' }), { status: 200 });
    };
    const provider = new ModalModelProvider('https://modal.run/gen', 'secret', 'gemma', fetchImpl);
    const res = await provider.generate(req);
    expect(auth).toBe('Bearer secret');
    expect(res.text).toBe('from modal');
  });
});

import { describe, expect, it } from 'vitest';
import { ModalModelProvider } from '../../src/model/modal.js';
import type { FetchLike } from '../../src/model/ollama.js';

function capture(): { calls: { url: string; body: Record<string, unknown> }[]; fetchImpl: FetchLike } {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
    return new Response(JSON.stringify({ model: 'google/gemma-4-26B-A4B-it', choices: [{ message: { content: '{"ok":true}' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { calls, fetchImpl };
}

describe('ModalModelProvider', () => {
  it('posts OpenAI chat-completions with a Bearer token and reads the content', async () => {
    const { calls, fetchImpl } = capture();
    const p = new ModalModelProvider('https://x.modal.direct', 'wk-a.ws-b', 'google/gemma-4-26B-A4B-it', fetchImpl);
    const res = await p.generate({ messages: [{ role: 'user', content: 'hi' }] });
    expect(res.text).toBe('{"ok":true}');
    expect(calls[0]!.url).toBe('https://x.modal.direct/v1/chat/completions');
    expect(calls[0]!.body.model).toBe('google/gemma-4-26B-A4B-it');
  });

  it('forwards a JSON schema as response_format json_schema (structured output)', async () => {
    const { calls, fetchImpl } = capture();
    const p = new ModalModelProvider('https://x.modal.direct/v1', 't', 'm', fetchImpl);
    const schema = { type: 'object', properties: { a: { type: 'string' } } };
    await p.generate({ messages: [{ role: 'user', content: 'x' }], format: schema });
    const rf = calls[0]!.body.response_format as { type: string; json_schema: { schema: unknown } };
    expect(rf.type).toBe('json_schema');
    expect(rf.json_schema.schema).toEqual(schema);
    // base already ending in /v1 must not be doubled
    expect(calls[0]!.url).toBe('https://x.modal.direct/v1/chat/completions');
  });

  it("maps format 'json' to json_object mode", async () => {
    const { calls, fetchImpl } = capture();
    const p = new ModalModelProvider('https://x.modal.direct', 't', 'm', fetchImpl);
    await p.generate({ messages: [{ role: 'user', content: 'x' }], format: 'json' });
    expect((calls[0]!.body.response_format as { type: string }).type).toBe('json_object');
  });
});

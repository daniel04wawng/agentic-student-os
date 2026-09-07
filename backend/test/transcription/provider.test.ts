import { describe, expect, it } from 'vitest';
import { DeepgramProvider, type FetchLike } from '../../src/transcription/provider.js';

const sample = {
  metadata: { duration: 12.5, request_id: 'req-1' },
  results: {
    channels: [
      {
        detected_language: 'en',
        alternatives: [
          {
            transcript: 'Hello world.',
            words: [
              { word: 'hello', punctuated_word: 'Hello', start: 0.1, end: 0.4, speaker: 0 },
              { word: 'world', punctuated_word: 'world.', start: 0.5, end: 0.9, speaker: 1 },
            ],
          },
        ],
      },
    ],
    utterances: [{ speaker: 0, start: 0.1, end: 0.9, transcript: 'Hello world.' }],
  },
};

describe('DeepgramProvider.parse', () => {
  it('maps transcript, diarized words with timestamps, and utterances', () => {
    const result = DeepgramProvider.parse(sample);
    expect(result.text).toBe('Hello world.');
    expect(result.language).toBe('en');
    expect(result.durationS).toBe(12.5);
    expect(result.requestId).toBe('req-1');
    expect(result.words).toEqual([
      { word: 'Hello', start: 0.1, end: 0.4, speaker: 0 },
      { word: 'world.', start: 0.5, end: 0.9, speaker: 1 },
    ]);
    expect(result.utterances).toHaveLength(1);
  });
});

describe('DeepgramProvider.transcribe', () => {
  it('sends the Token auth header and parses a 200 response', async () => {
    let authHeader: string | undefined;
    const fetchImpl: FetchLike = async (_url, init) => {
      authHeader = (init?.headers as Record<string, string>).Authorization;
      return new Response(JSON.stringify(sample), { status: 200 });
    };
    const provider = new DeepgramProvider('secret', fetchImpl);
    const result = await provider.transcribe(Buffer.from('audio'), 'audio/m4a');
    expect(authHeader).toBe('Token secret');
    expect(result.text).toBe('Hello world.');
  });

  it('throws on a non-2xx response', async () => {
    const fetchImpl: FetchLike = async () => new Response('nope', { status: 402 });
    const provider = new DeepgramProvider('secret', fetchImpl);
    await expect(provider.transcribe(Buffer.from('a'), 'audio/m4a')).rejects.toThrow(/402/);
  });
});

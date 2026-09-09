import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { createTranscriptionProvider } from '../../src/transcription/factory.js';
import { DeepgramProvider, FakeTranscriptionProvider } from '../../src/transcription/provider.js';

const base = { INNGEST_DEV: '0', AUTO_SUBMIT: '0' };

describe('createTranscriptionProvider', () => {
  it('uses the fake provider when no Deepgram key is set', () => {
    const provider = createTranscriptionProvider(loadConfig({ ...base } as NodeJS.ProcessEnv));
    expect(provider).toBeInstanceOf(FakeTranscriptionProvider);
  });

  it('uses Deepgram when a key is configured', () => {
    const provider = createTranscriptionProvider(
      loadConfig({ ...base, DEEPGRAM_API_KEY: 'dg_test_key' } as NodeJS.ProcessEnv),
    );
    expect(provider).toBeInstanceOf(DeepgramProvider);
  });
});

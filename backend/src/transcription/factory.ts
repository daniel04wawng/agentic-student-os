import type { Config } from '../config.js';
import { DeepgramProvider, FakeTranscriptionProvider, type TranscriptionProvider } from './provider.js';

/**
 * Build the configured transcription provider. Uses Deepgram when
 * DEEPGRAM_API_KEY is set, otherwise a deterministic fake so the rest of the
 * pipeline runs without a key. Deepgram authenticates with a plain API token,
 * so there is no OAuth/broker step.
 */
export function createTranscriptionProvider(config: Config): TranscriptionProvider {
  if (config.DEEPGRAM_API_KEY) {
    return new DeepgramProvider(config.DEEPGRAM_API_KEY);
  }
  return new FakeTranscriptionProvider();
}

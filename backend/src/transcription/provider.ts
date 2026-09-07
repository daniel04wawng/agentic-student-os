/**
 * Transcription provider abstraction. Deepgram is the concrete provider (needs
 * an API key); a fake is used in tests. Preserves word-level timestamps and
 * speaker labels (diarization).
 */
export interface TranscriptWord {
  word: string;
  start: number;
  end: number;
  speaker?: number;
}

export interface TranscriptUtterance {
  speaker?: number;
  start: number;
  end: number;
  text: string;
}

export interface TranscriptionResult {
  text: string;
  language?: string;
  durationS?: number;
  words: TranscriptWord[];
  utterances: TranscriptUtterance[];
  requestId?: string;
}

export interface TranscriptionProvider {
  transcribe(audio: Buffer, contentType: string): Promise<TranscriptionResult>;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Deepgram prerecorded transcription with diarization + utterances. */
export class DeepgramProvider implements TranscriptionProvider {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: FetchLike = globalThis.fetch as FetchLike,
    private readonly baseUrl = 'https://api.deepgram.com',
  ) {}

  async transcribe(audio: Buffer, contentType: string): Promise<TranscriptionResult> {
    const url = `${this.baseUrl}/v1/listen?model=nova-2&smart_format=true&diarize=true&utterances=true&punctuate=true`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Token ${this.apiKey}`, 'Content-Type': contentType },
      body: new Uint8Array(audio),
    });
    if (!res.ok) throw new Error(`Deepgram ${res.status}`);
    return DeepgramProvider.parse((await res.json()) as DeepgramResponse);
  }

  static parse(body: DeepgramResponse): TranscriptionResult {
    const channel = body.results?.channels?.[0];
    const alt = channel?.alternatives?.[0];
    const words: TranscriptWord[] = (alt?.words ?? []).map((w) => ({
      word: w.punctuated_word ?? w.word,
      start: w.start,
      end: w.end,
      speaker: w.speaker,
    }));
    const utterances: TranscriptUtterance[] = (body.results?.utterances ?? []).map((u) => ({
      speaker: u.speaker,
      start: u.start,
      end: u.end,
      text: u.transcript,
    }));
    return {
      text: alt?.transcript ?? '',
      language: channel?.detected_language,
      durationS: body.metadata?.duration,
      words,
      utterances,
      requestId: body.metadata?.request_id,
    };
  }
}

// Minimal shape of the parts of the Deepgram response we consume.
interface DeepgramResponse {
  metadata?: { duration?: number; request_id?: string };
  results?: {
    channels?: {
      detected_language?: string;
      alternatives?: {
        transcript?: string;
        words?: { word: string; punctuated_word?: string; start: number; end: number; speaker?: number }[];
      }[];
    }[];
    utterances?: { speaker?: number; start: number; end: number; transcript: string }[];
  };
}

/** Deterministic fake for tests. Optionally fails to exercise failure paths. */
export class FakeTranscriptionProvider implements TranscriptionProvider {
  constructor(private readonly opts: { fail?: boolean } = {}) {}

  async transcribe(): Promise<TranscriptionResult> {
    if (this.opts.fail) throw new Error('transcription provider unavailable');
    return {
      text: 'hello world',
      language: 'en',
      durationS: 1.2,
      words: [
        { word: 'hello', start: 0.0, end: 0.5, speaker: 0 },
        { word: 'world', start: 0.6, end: 1.1, speaker: 1 },
      ],
      utterances: [
        { speaker: 0, start: 0.0, end: 0.5, text: 'hello' },
        { speaker: 1, start: 0.6, end: 1.1, text: 'world' },
      ],
      requestId: 'fake-req',
    };
  }
}

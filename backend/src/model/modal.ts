import { ModelUnavailableError, type ModelProvider, type ModelRequest, type ModelResponse } from './provider.js';
import type { FetchLike } from './ollama.js';

/**
 * Heavy model hosted on a Modal LLM Endpoint (OpenAI-compatible, e.g. Gemma 4
 * 26B-A4B). Bursty GPU, no always-on requirement. Needs the endpoint base URL +
 * a Bearer token (Modal proxy token: "wk-....ws-...").
 *
 * Structured output: Modal endpoints serve vLLM's OpenAI API, which supports
 * `response_format` with a JSON schema (schema-constrained decoding). We forward
 * the app's `format` as that, so class prep and other structured calls get valid
 * JSON here just like they do on Ollama.
 */
export class ModalModelProvider implements ModelProvider {
  readonly name = 'modal';

  constructor(
    private readonly endpoint: string | undefined,
    private readonly token: string | undefined,
    private readonly model = 'gemma',
    private readonly fetchImpl: FetchLike = globalThis.fetch as FetchLike,
  ) {}

  /** Resolve the chat-completions URL from whatever base form is configured. */
  private chatUrl(): string {
    const base = (this.endpoint ?? '').replace(/\/+$/, '');
    if (base.endsWith('/chat/completions')) return base;
    if (base.endsWith('/v1')) return `${base}/chat/completions`;
    return `${base}/v1/chat/completions`;
  }

  private responseFormat(format: ModelRequest['format']): Record<string, unknown> | undefined {
    if (!format) return undefined;
    if (format === 'json') return { type: 'json_object' };
    return { type: 'json_schema', json_schema: { name: 'student_os_output', schema: format, strict: true } };
  }

  async generate(req: ModelRequest): Promise<ModelResponse> {
    if (!this.endpoint) throw new ModelUnavailableError('Modal endpoint not configured');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;

    const body: Record<string, unknown> = {
      model: req.model ?? this.model,
      messages: req.messages,
      temperature: req.temperature ?? 0,
      max_tokens: req.maxTokens ?? 2048,
    };
    const rf = this.responseFormat(req.format);
    if (rf) body.response_format = rf;

    // Scale-to-zero endpoints spin a cold container up on first hit. For a large
    // model that can take several minutes, during which the endpoint returns
    // 503/502 or briefly drops the connection. Retry through the whole warm-up so
    // an unattended prep/notes run surfaces a cold start as latency, not an empty
    // fallback. ~10 min budget comfortably exceeds the observed ~5 min cold start.
    const coldStartRetries = 120; // 120 x 5s = ~10 min of warm-up
    let res: Response | undefined;
    for (let attempt = 0; ; attempt += 1) {
      try {
        res = await this.fetchImpl(this.chatUrl(), { method: 'POST', headers, body: JSON.stringify(body) });
      } catch (err) {
        // A dropped connection during warm-up is retryable; only give up once
        // the cold-start budget is spent.
        if (attempt < coldStartRetries) {
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }
        throw new ModelUnavailableError(`Modal unreachable: ${err instanceof Error ? err.message : String(err)}`);
      }
      if ((res.status === 503 || res.status === 502) && attempt < coldStartRetries) {
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      break;
    }
    if (!res || !res.ok) throw new ModelUnavailableError(`Modal ${res?.status ?? 'unreachable'}`);
    const parsed = (await res.json()) as {
      model?: string;
      choices?: { message?: { content?: string } }[];
    };
    return { text: parsed.choices?.[0]?.message?.content ?? '', model: parsed.model ?? this.model };
  }
}

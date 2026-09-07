import { ModelUnavailableError, type ModelProvider, type ModelRequest, type ModelResponse } from './provider.js';
import type { FetchLike } from './ollama.js';

/** Heavy model hosted on Modal (bursty GPU, no always-on requirement). Needs the endpoint + token. */
export class ModalModelProvider implements ModelProvider {
  readonly name = 'modal';

  constructor(
    private readonly endpoint: string | undefined,
    private readonly token: string | undefined,
    private readonly model = 'gemma',
    private readonly fetchImpl: FetchLike = globalThis.fetch as FetchLike,
  ) {}

  async generate(req: ModelRequest): Promise<ModelResponse> {
    if (!this.endpoint) throw new ModelUnavailableError('Modal endpoint not configured');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;

    const res = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: req.model ?? this.model,
        messages: req.messages,
        temperature: req.temperature ?? 0,
        max_tokens: req.maxTokens,
      }),
    });
    if (!res.ok) throw new ModelUnavailableError(`Modal ${res.status}`);
    const body = (await res.json()) as {
      text?: string;
      choices?: { message?: { content?: string } }[];
    };
    return { text: body.text ?? body.choices?.[0]?.message?.content ?? '', model: this.model };
  }
}

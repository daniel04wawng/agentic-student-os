import { ModelUnavailableError, type ModelProvider, type ModelRequest, type ModelResponse } from './provider.js';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Local model via Ollama (http://localhost:11434). Needs Ollama running with a pulled model (e.g. gemma2). */
export class OllamaModelProvider implements ModelProvider {
  readonly name = 'ollama';

  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly fetchImpl: FetchLike = globalThis.fetch as FetchLike,
  ) {}

  async generate(req: ModelRequest): Promise<ModelResponse> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl.replace(/\/+$/, '')}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: req.model ?? this.model,
          messages: req.messages,
          stream: false,
          options: { temperature: req.temperature ?? 0 },
        }),
      });
    } catch (err) {
      throw new ModelUnavailableError(`Ollama unreachable: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) throw new ModelUnavailableError(`Ollama ${res.status}`);
    const body = (await res.json()) as { model?: string; message?: { content?: string } };
    return { text: body.message?.content ?? '', model: body.model ?? this.model };
  }
}

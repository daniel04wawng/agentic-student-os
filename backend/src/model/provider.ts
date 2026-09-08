/**
 * Model provider abstraction. One interface over the local model (Ollama /
 * on-device Gemma) and the Modal-hosted heavy model. A deterministic fake is
 * used in tests. Keeping this narrow lets the planner and generators depend on a
 * stable contract regardless of where inference runs.
 */
export interface ModelMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ModelRequest {
  messages: ModelMessage[];
  temperature?: number;
  maxTokens?: number;
  model?: string;
  /**
   * Constrained output format. 'json' forces syntactically-valid JSON; a JSON
   * Schema object requests schema-constrained decoding (Ollama structured
   * outputs). Providers ignore what they do not support.
   */
  format?: 'json' | Record<string, unknown>;
}

export interface ModelResponse {
  text: string;
  model: string;
}

export interface ModelProvider {
  readonly name: string;
  generate(req: ModelRequest): Promise<ModelResponse>;
}

export class ModelUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelUnavailableError';
  }
}

/** Deterministic fake provider for tests. `responder` maps a request to text. */
export class FakeModelProvider implements ModelProvider {
  readonly name = 'fake';
  private calls = 0;

  constructor(private readonly responder: (req: ModelRequest, call: number) => string) {}

  get callCount(): number {
    return this.calls;
  }

  async generate(req: ModelRequest): Promise<ModelResponse> {
    const text = this.responder(req, this.calls);
    this.calls += 1;
    return { text, model: 'fake' };
  }
}

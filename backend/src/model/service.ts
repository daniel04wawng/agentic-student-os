import type { ZodTypeAny, z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { currentTraceId } from '../trace.js';
import { hashRequest, type InferenceCache } from './cache.js';
import {
  ModelUnavailableError,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
} from './provider.js';

/** Extract a JSON object/array from model text (handles ```json fences + prose). */
export function extractJson(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced ? fenced[1]! : text;
  const objStart = body.indexOf('{');
  const objEnd = body.lastIndexOf('}');
  if (objStart >= 0 && objEnd > objStart) return body.slice(objStart, objEnd + 1);
  const arrStart = body.indexOf('[');
  const arrEnd = body.lastIndexOf(']');
  if (arrStart >= 0 && arrEnd > arrStart) return body.slice(arrStart, arrEnd + 1);
  return body.trim();
}

export interface TraceInfo {
  model: string;
  ms: number;
  cacheHit: boolean;
  traceId?: string;
}

export interface ModelServiceDeps {
  cache?: InferenceCache;
  onTrace?: (info: TraceInfo) => void;
}

export interface StructuredOptions<T> {
  /** Deterministic value used when the model is unavailable or invalid. */
  fallback?: () => T;
  retries?: number;
}

function tryParse<S extends ZodTypeAny>(
  text: string,
  schema: S,
): { ok: true; value: z.infer<S> } | { ok: false } {
  try {
    return { ok: true, value: schema.parse(JSON.parse(extractJson(text))) as z.infer<S> };
  } catch {
    return { ok: false };
  }
}

/**
 * Wraps a provider with caching (skip repeated inference), structured-output
 * validation with retries, a deterministic fallback (used when the model is
 * unavailable or keeps returning invalid output), and inference tracing.
 */
export class ModelService {
  constructor(
    private readonly provider: ModelProvider,
    private readonly deps: ModelServiceDeps = {},
  ) {}

  async generate(req: ModelRequest): Promise<ModelResponse> {
    const key = hashRequest(req);
    const cached = this.deps.cache?.get(key);
    if (cached !== undefined) {
      this.trace(this.provider.name, 0, true);
      return { text: cached, model: this.provider.name };
    }
    const start = Date.now();
    const res = await this.provider.generate(req);
    this.deps.cache?.set(key, res.text);
    this.trace(res.model, Date.now() - start, false);
    return res;
  }

  async generateStructured<S extends ZodTypeAny>(
    req: ModelRequest,
    schema: S,
    opts: StructuredOptions<z.infer<S>> = {},
  ): Promise<z.infer<S>> {
    // Request schema-constrained decoding from providers that support it.
    const jsonSchema = zodToJsonSchema(schema) as Record<string, unknown>;
    delete jsonSchema.$schema;
    const structuredReq: ModelRequest = { ...req, format: jsonSchema };

    const key = hashRequest(structuredReq);
    const cached = this.deps.cache?.get(key);
    if (cached !== undefined) {
      const parsedCached = tryParse(cached, schema);
      if (parsedCached.ok) {
        this.trace(this.provider.name, 0, true);
        return parsedCached.value;
      }
    }

    const retries = opts.retries ?? 1;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const start = Date.now();
        const res = await this.provider.generate(structuredReq);
        this.trace(res.model, Date.now() - start, false);
        const parsed = tryParse(res.text, schema);
        if (parsed.ok) {
          this.deps.cache?.set(key, res.text);
          return parsed.value;
        }
      } catch {
        // provider error: fall through to retry / fallback
      }
    }

    if (opts.fallback) return opts.fallback();
    throw new ModelUnavailableError('structured generation failed and no fallback was provided');
  }

  private trace(model: string, ms: number, cacheHit: boolean): void {
    this.deps.onTrace?.({ model, ms, cacheHit, traceId: currentTraceId() });
  }
}

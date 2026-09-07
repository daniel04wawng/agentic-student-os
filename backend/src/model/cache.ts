import { createHash } from 'node:crypto';
import type { ModelRequest } from './provider.js';

/**
 * Inference cache: avoid repeated inference on unchanged inputs (cost control).
 * In-memory by default; a DB-backed implementation can persist across restarts
 * later without changing the interface.
 */
export interface InferenceCache {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
}

/** Stable hash of a request, so identical inputs share a cache entry. */
export function hashRequest(req: ModelRequest): string {
  const canonical = JSON.stringify({
    messages: req.messages,
    temperature: req.temperature ?? null,
    maxTokens: req.maxTokens ?? null,
    model: req.model ?? null,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/** Simple bounded in-memory cache (FIFO eviction). */
export class InMemoryInferenceCache implements InferenceCache {
  private readonly store = new Map<string, string>();

  constructor(private readonly maxEntries = 1000) {}

  get(key: string): string | undefined {
    return this.store.get(key);
  }

  set(key: string, value: string): void {
    if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, value);
  }
}

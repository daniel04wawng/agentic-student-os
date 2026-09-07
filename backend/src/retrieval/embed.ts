/**
 * Embedding abstraction. The real embedder (Gemma via the inference service,
 * PR 12) implements this; a deterministic fake is used in tests. Dimensionality
 * is model-specific and not enforced by the storage column (float array).
 */
export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
}

/** Cosine similarity of two equal-length vectors (0 for a zero vector). */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export const FAKE_EMBED_DIM = 256;

/**
 * Deterministic bag-of-words embedder for tests: hashes tokens into buckets and
 * L2-normalizes, so texts that share vocabulary have higher cosine similarity.
 */
export class FakeEmbedder implements Embedder {
  constructor(private readonly dim = FAKE_EMBED_DIM) {}

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.vector(t));
  }

  private vector(text: string): number[] {
    const v = new Array<number>(this.dim).fill(0);
    for (const token of text.toLowerCase().split(/\W+/).filter(Boolean)) {
      let h = 0;
      for (let i = 0; i < token.length; i += 1) h = (h * 31 + token.charCodeAt(i)) >>> 0;
      v[h % this.dim]! += 1;
    }
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  }
}

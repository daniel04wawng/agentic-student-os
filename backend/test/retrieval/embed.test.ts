import { describe, expect, it } from 'vitest';
import { FakeEmbedder, cosineSimilarity } from '../../src/retrieval/embed.js';

describe('cosineSimilarity', () => {
  it('is 1 for identical, 0 for orthogonal and zero vectors', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

describe('FakeEmbedder', () => {
  it('is deterministic and ranks shared-vocabulary text as more similar', async () => {
    const e = new FakeEmbedder();
    const [a1] = await e.embed(['photosynthesis in plants']);
    const [a2] = await e.embed(['photosynthesis in plants']);
    expect(a1).toEqual(a2); // deterministic

    const [q] = await e.embed(['photosynthesis chloroplast']);
    const [related] = await e.embed(['photosynthesis converts light']);
    const [unrelated] = await e.embed(['the mitochondria powerhouse cell']);
    expect(cosineSimilarity(q!, related!)).toBeGreaterThan(cosineSimilarity(q!, unrelated!));
  });
});

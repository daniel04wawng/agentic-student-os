import { describe, expect, it } from 'vitest';
import { chunkText, chunkUtterances } from '../../src/retrieval/chunk.js';

describe('chunkUtterances', () => {
  it('groups utterances under the char budget and preserves timestamps', () => {
    const chunks = chunkUtterances(
      [
        { speaker: 0, start: 0, end: 1, text: 'aaaa' },
        { speaker: 1, start: 1, end: 2, text: 'bbbb' },
        { speaker: 0, start: 2, end: 3, text: 'cccc' },
      ],
      10,
    );
    // "aaaa bbbb" = 9 chars fits; adding "cccc" would exceed 10 -> new chunk.
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({ text: 'aaaa bbbb', start_s: 0, end_s: 2 });
    expect(chunks[1]).toMatchObject({ text: 'cccc', start_s: 2, end_s: 3 });
  });

  it('skips empty utterances', () => {
    expect(chunkUtterances([{ speaker: 0, start: 0, end: 1, text: '  ' }])).toHaveLength(0);
  });
});

describe('chunkText', () => {
  it('splits on sentence boundaries within the budget', () => {
    const chunks = chunkText('One two three. Four five six. Seven eight nine.', 20);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]!.start_s).toBeNull();
  });
});

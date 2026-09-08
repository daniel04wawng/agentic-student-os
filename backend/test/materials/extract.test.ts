import { describe, expect, it } from 'vitest';
import { extractText } from '../../src/materials/extract.js';

const TINY_PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length 44>>stream\nBT /F1 12 Tf 20 100 Td (Hello Case 42) Tj ET\nendstream endobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R/Size 6>>\n%%EOF',
);

describe('extractText', () => {
  it('extracts text from PDF bytes in memory', async () => {
    const text = await extractText(TINY_PDF, 'application/pdf');
    expect(text).toContain('Hello Case 42');
  });

  it('passes through text-like content', async () => {
    expect(await extractText(Buffer.from('plain notes'), 'text/plain')).toBe('plain notes');
  });

  it('detects PDF by magic bytes even without a content type', async () => {
    expect(await extractText(TINY_PDF, '')).toContain('Hello Case 42');
  });

  it('strips NUL / control bytes that Postgres text cannot store', async () => {
    // bytes: 'a', NUL(0), 'b', BEL(7), 'c', TAB(9), 'd', LF(10), 'e'
    const dirty = Buffer.from([97, 0, 98, 7, 99, 9, 100, 10, 101]);
    const out = await extractText(dirty, 'text/plain');
    expect(out).toBe('abc\td\ne'); // NUL + BEL removed; tab + newline kept
    expect(out.includes(String.fromCharCode(0))).toBe(false);
  });
});

import { extractText as unpdfExtractText, getDocumentProxy } from 'unpdf';

function looksLikePdf(bytes: Buffer): boolean {
  return bytes.subarray(0, 5).toString('latin1') === '%PDF-';
}

/**
 * Extract plain text from file bytes IN MEMORY. Handles PDF (via unpdf) and
 * falls back to UTF-8 for text-like files. The caller keeps only the returned
 * text and discards the bytes — the original file is never persisted.
 */
export async function extractText(bytes: Buffer, contentType: string): Promise<string> {
  if (/pdf/i.test(contentType) || looksLikePdf(bytes)) {
    const doc = await getDocumentProxy(new Uint8Array(bytes));
    const { text } = await unpdfExtractText(doc, { mergePages: true });
    return Array.isArray(text) ? text.join('\n') : text;
  }
  return bytes.toString('utf8');
}

export type Extractor = (bytes: Buffer, contentType: string) => Promise<string>;

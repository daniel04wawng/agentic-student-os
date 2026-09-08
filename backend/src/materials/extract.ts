import { extractText as unpdfExtractText, getDocumentProxy } from 'unpdf';

function looksLikePdf(bytes: Buffer): boolean {
  return bytes.subarray(0, 5).toString('latin1') === '%PDF-';
}

/**
 * Extract plain text from file bytes IN MEMORY. Handles PDF (via unpdf) and
 * falls back to UTF-8 for text-like files. The caller keeps only the returned
 * text and discards the bytes; the original file is never persisted.
 */
export async function extractText(bytes: Buffer, contentType: string): Promise<string> {
  if (/pdf/i.test(contentType) || looksLikePdf(bytes)) {
    const doc = await getDocumentProxy(new Uint8Array(bytes));
    const { text } = await unpdfExtractText(doc, { mergePages: true });
    return sanitize(Array.isArray(text) ? text.join('\n') : text);
  }
  return sanitize(bytes.toString('utf8'));
}

/**
 * Strip NUL bytes and other C0 control chars (keeping tab, newline, carriage
 * return). Postgres `text` rejects U+0000 outright, and extraction of
 * partial/garbled PDF text layers can emit them; a stray control char must
 * never blow up storage.
 */
function sanitize(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

export type Extractor = (bytes: Buffer, contentType: string) => Promise<string>;

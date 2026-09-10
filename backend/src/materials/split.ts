export interface CaseSegment {
  /** Case title (from the coursepack's table of contents, or the header line). */
  title: string;
  /** Full text of this case within the coursepack. */
  text: string;
}

/** Ivey case product codes (e.g. 9B18M132, W34978) that begin each case. */
const PRODUCT_CODE = /\b(9B\d{2}[A-Z]\d{3}|W\d{5}|\dB\d{2}[A-Z]\d{3})\b/g;

/** Fraction of a string's letters that are uppercase. */
function upperRatio(s: string): number {
  const letters = s.replace(/[^A-Za-z]/g, '');
  if (!letters) return 0;
  return (letters.match(/[A-Z]/g)?.length ?? 0) / letters.length;
}

/**
 * Build a lenient regex that matches a title regardless of case, whitespace, or
 * punctuation differences. The coursepack body prints titles in ALL CAPS with
 * curly apostrophes while the table of contents uses title case with straight
 * ones, so we match on the alphanumeric word tokens only, joined by "any run of
 * non-alphanumerics". Uses the first several tokens to stay specific.
 */
function titleNeedle(title: string): RegExp | null {
  const tokens = title
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .slice(0, 6)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (tokens.length < 2) return null;
  return new RegExp(tokens.join('[^A-Za-z0-9]+'), 'ig');
}

interface TocEntry {
  title: string;
  /** Absolute index in `text` just past this entry in the table of contents. */
  tocEnd: number;
}

/**
 * Parse an Ivey coursepack's table of contents into an ordered list of case
 * titles. Entries read "Title <page number>" with strictly ascending page
 * numbers; we stop at the first non-ascending number (the junk that follows the
 * last entry). Returns null when there is no usable ToC.
 */
function parseToc(text: string): TocEntry[] | null {
  const head = /Table\s+Of\s+Contents/i.exec(text);
  if (!head) return null;
  const regionStart = head.index + head[0].length;
  const region = text.slice(regionStart, regionStart + 2500);
  const entries: TocEntry[] = [];
  let lastPage = 0;
  const re = /([^\d]+?)\s+(\d{1,3})(?=\s|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(region))) {
    const page = Number(m[2]);
    const title = m[1]!.replace(/\s+/g, ' ').trim();
    if (page <= lastPage) break; // page numbers only ascend within a real ToC
    if (title.length < 4) continue;
    entries.push({ title, tocEnd: regionStart + re.lastIndex });
    lastPage = page;
  }
  return entries.length >= 2 ? entries : null;
}

/**
 * Split by the table of contents: locate each ToC title in the body (in order,
 * scanning forward past the ToC itself) and cut there. This captures every case
 * including ones without an Ivey product code (e.g. reprinted HBS cases).
 */
function splitByToc(text: string): CaseSegment[] {
  const toc = parseToc(text);
  if (!toc) return [];
  const bodyStart = toc[toc.length - 1]!.tocEnd; // past the whole ToC block
  const starts: { index: number; title: string }[] = [];
  let cursor = bodyStart;
  for (const entry of toc) {
    const re = titleNeedle(entry.title);
    if (!re) continue;
    re.lastIndex = cursor;
    const hit = re.exec(text);
    if (!hit) continue; // title not found in body; folds into the previous case
    starts.push({ index: hit.index, title: entry.title });
    cursor = hit.index + 1;
  }
  if (starts.length < 2) return [];
  return starts.map((s, i) => ({
    title: s.title,
    text: text.slice(s.index, i + 1 < starts.length ? starts[i + 1]!.index : text.length),
  }));
}

/** Split by Ivey product-code title pages (fallback when there is no ToC). */
function splitByProductCode(text: string): CaseSegment[] {
  const starts: { index: number; title: string }[] = [];
  // Ivey repeats the product code in the footer of every page, so the same code
  // recurs dozens of times; only the FIRST occurrence is the case's title page.
  const seenCode = new Set<string>();
  for (const m of text.matchAll(PRODUCT_CODE)) {
    const code = m[0];
    if (seenCode.has(code)) continue;
    seenCode.add(code); // lock onto the first sighting; later footers are repeats
    const after = text.slice(m.index! + code.length, m.index! + code.length + 90);
    const titleMatch = /^[\s.:]*([A-Z][A-Z0-9 ,&:'’\-–?]{8,70})/.exec(after);
    if (!titleMatch) continue;
    const title = titleMatch[1]!.replace(/\s+/g, ' ').trim();
    if (upperRatio(title) < 0.85) continue; // a real header, not prose
    if (/^EXHIBIT\b|^CONTINUED\b/i.test(title)) continue; // an exhibit page, not a case
    starts.push({ index: m.index!, title });
  }
  if (starts.length < 2) return [];

  const segments: CaseSegment[] = [];
  // Text before the first coded case is itself the first case (often lacks a code).
  if (starts[0]!.index > 3000) {
    segments.push({ title: 'Case 1', text: text.slice(0, starts[0]!.index) });
  }
  for (let i = 0; i < starts.length; i += 1) {
    const end = i + 1 < starts.length ? starts[i + 1]!.index : text.length;
    segments.push({ title: starts[i]!.title, text: text.slice(starts[i]!.index, end) });
  }
  return segments;
}

/**
 * Split an Ivey coursepack into its individual cases, in teaching order. Prefers
 * the table of contents (captures every case, including non-Ivey reprints);
 * falls back to Ivey product-code title pages. Returns [] when the text is not a
 * recognizable multi-case coursepack.
 */
export function splitCoursepack(text: string): CaseSegment[] {
  const byToc = splitByToc(text);
  if (byToc.length >= 2) return byToc;
  return splitByProductCode(text);
}

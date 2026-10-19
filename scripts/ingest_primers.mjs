// Chunk the OCR'd primer text and load it into resource_chunks, tagged to the
// course. Idempotent: clears the course's existing resource_chunks first.
//
// Run:  DATABASE_URL=<supabase session pooler url> \
//         node scripts/ingest_primers.mjs <ocr-txt-dir> "<course name match>"
//
// After this, embed the rows with:  modal run deploy/modal_embed.py::backfill
// and re-transcribe the scrambled table/figure pages with deploy/modal_ocr.py.
import { readFileSync, readdirSync } from 'node:fs';
import pg from 'pg';

const OCR_DIR = process.argv[2];
const COURSE_MATCH = process.argv[3] ?? 'Global Macro';
if (!OCR_DIR) throw new Error('usage: node ingest_primers.mjs <ocr-dir> "<course name>"');
if (!process.env.DATABASE_URL) throw new Error('set DATABASE_URL');

// Drop running header/footer lines; detect a "Section N" marker whose following
// line is the section heading. Join the rest into one page blob.
function cleanPage(raw) {
  const lines = raw.split('\n').map((l) => l.trim());
  const kept = [];
  let section = null;
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i];
    if (!l) continue;
    if (/^global macroeconomics for managers/i.test(l)) continue; // footer
    if (/^primer\s+\S+\s*[-·.]\s*\d+/i.test(l)) continue; // "Primer 06 . 10" page no.
    if (/^section\s+\d+$/i.test(l)) {
      const next = lines.slice(i + 1).find(Boolean);
      if (next) section = next;
      continue;
    }
    kept.push(l);
  }
  return { text: kept.join(' ').replace(/\s+/g, ' ').trim(), section };
}

// Primer number from the OCR'd footer, tolerant of the common 0<->8 misread.
function primerTitle(raw) {
  const m = /primer\s+(\d{1,2})\b/i.exec(raw);
  if (m) {
    let n = m[1];
    if (n.length === 2 && n[0] === '8') n = `0${n[1]}`; // "87" -> "07"
    return `Primer ${n.padStart(2, '0')}`;
  }
  return 'GMM Primer';
}

// Split a page blob into ~1500-char chunks on sentence boundaries.
function chunkText(text, size = 1500) {
  if (text.length <= size) return [text];
  const sentences = text.split(/(?<=[.?!])\s+/);
  const chunks = [];
  let buf = '';
  for (const s of sentences) {
    if ((buf + ' ' + s).length > size && buf) {
      chunks.push(buf.trim());
      buf = s;
    } else {
      buf = buf ? `${buf} ${s}` : s;
    }
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks;
}

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

const course = await db.query(
  `SELECT id, name FROM courses WHERE name ILIKE $1 ORDER BY name LIMIT 1`,
  [`%${COURSE_MATCH}%`],
);
if (course.rows.length === 0) throw new Error(`course not found: ${COURSE_MATCH}`);
const courseId = course.rows[0].id;
console.log('course:', course.rows[0].name, courseId);

await db.query(`DELETE FROM resource_chunks WHERE course_id = $1`, [courseId]);

const files = readdirSync(OCR_DIR).filter((f) => f.endsWith('.txt')).sort();
let idx = 0;
let inserted = 0;
for (const f of files) {
  const raw = readFileSync(`${OCR_DIR}/${f}`, 'utf8');
  const { text, section } = cleanPage(raw);
  const title = primerTitle(raw);
  for (const chunk of chunkText(text)) {
    await db.query(
      `INSERT INTO resource_chunks (course_id, source_title, section, chunk_index, text, metadata)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
      [courseId, title, section, idx++, chunk, JSON.stringify({ page_file: f })],
    );
    inserted += 1;
  }
}
console.log(`inserted ${inserted} chunks from ${files.length} pages`);
await db.end();

import type { SqlClient } from '../db/client.js';
import type { ModelMessage } from '../model/provider.js';
import type { ModelService } from '../model/service.js';
import type { Embedder } from '../retrieval/embed.js';
import { fullTextSearch, semanticResourceSearch } from '../retrieval/search.js';

/**
 * Study chat. The student asks a free-form question and gets an answer grounded
 * in the knowledge base: course primers/textbook chunks (shared, always
 * available), plus - when the user has connected Canvas - their own materials
 * and lecture transcripts. Retrieval is full-text and course-scoped where a
 * course is given. The model is told to answer from the retrieved context and to
 * say when the answer is not in it.
 */

export interface ChatSource {
  type: 'primer' | 'material' | 'lecture';
  title: string;
  /** The actual passage used, so the client can show what was cited. */
  snippet?: string;
}

export interface ChatAnswer {
  answer: string;
  sources: ChatSource[];
}

/** Per-snippet and total context budgets, so one long source can't crowd out the rest. */
const PER_SNIPPET_CHARS = 2000;
const TOTAL_CONTEXT_CHARS = 12000;

interface ResourceHit {
  id: string;
  source_title: string | null;
  section: string | null;
  text: string;
}

/** Full-text search over course primers / textbook chunks (the shared knowledge base). */
async function searchResourceChunks(
  db: SqlClient,
  query: string,
  courseId: string | undefined,
  limit: number,
): Promise<ResourceHit[]> {
  // OR the query's terms (plainto ANDs them, which fails on full questions),
  // ranked by relevance so the best-matching chunks still come first.
  const { rows } = await db.query<ResourceHit>(
    `SELECT id, source_title, section, left(text, $4) AS text
     FROM resource_chunks,
          to_tsquery('english', replace(plainto_tsquery('english', $1)::text, ' & ', ' | ')) q
     WHERE ($2::uuid IS NULL OR course_id = $2::uuid) AND tsv @@ q
     ORDER BY ts_rank(tsv, q) DESC
     LIMIT $3`,
    [query, courseId ?? null, limit, PER_SNIPPET_CHARS],
  );
  return rows;
}

/**
 * Combined primer retrieval: semantic (meaning-based, when an embedder is
 * configured) with keyword search as a backstop. Semantic hits come first
 * because they match the question's intent, not just its words; keyword hits
 * fill in anything semantic missed. Deduped by chunk id.
 */
async function retrievePrimers(
  db: SqlClient,
  embedder: Embedder | undefined,
  query: string,
  courseId: string | undefined,
  limit: number,
): Promise<ResourceHit[]> {
  const [semantic, keyword] = await Promise.all([
    embedder
      ? semanticResourceSearch(db, embedder, query, { courseId, limit }).catch(() => [])
      : Promise.resolve([]),
    searchResourceChunks(db, query, courseId, limit),
  ]);

  const out: ResourceHit[] = [];
  const seen = new Set<string>();
  for (const s of semantic) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    out.push({ id: s.id, source_title: s.source_title, section: s.section, text: s.text });
  }
  for (const k of keyword) {
    if (seen.has(k.id)) continue;
    seen.add(k.id);
    out.push(k);
  }
  return out.slice(0, limit);
}

interface MaterialHit {
  title: string | null;
  kind: string;
  text: string;
}

/** Full-text search over course materials (readings/cases/slides) - Canvas-connected users. */
async function searchMaterials(
  db: SqlClient,
  query: string,
  courseId: string | undefined,
  limit: number,
): Promise<MaterialHit[]> {
  const { rows } = await db.query<MaterialHit>(
    `SELECT title, kind, left(text, $4) AS text
     FROM materials,
          to_tsquery('english', replace(plainto_tsquery('english', $1)::text, ' & ', ' | ')) q
     WHERE tsv @@ q AND length(text) >= 20
       AND ($2::uuid IS NULL OR course_id = $2::uuid)
     ORDER BY ts_rank(tsv, q) DESC
     LIMIT $3`,
    [query, courseId ?? null, limit, PER_SNIPPET_CHARS],
  );
  return rows;
}

const CHAT_SYSTEM = [
  "You are the student's study assistant. Answer the question using the CONTEXT below, which is",
  'drawn from their course primers/textbook and (when available) their own materials and lecture',
  'notes.',
  'Be specific and concrete: lead with the direct answer, then name the exact concepts, definitions,',
  'conditions, formulas, or figures from the context that support it. Quote key terms and numbers',
  'verbatim rather than paraphrasing vaguely. Cite each claim with the bracketed label of the source',
  'it came from (e.g. [P1], [M2], [L1]); put the label right after the sentence it supports.',
  'Do not pad with generic background the student did not ask for. If the context does not contain the',
  'answer, say so plainly in one line, then you may answer briefly from general knowledge and flag',
  'that it is not from the course material. Do not use em dashes.',
].join(' ');

/**
 * Answer a question grounded in the knowledge base. Primers come first (the
 * shared, always-available knowledge), then Canvas materials and lecture
 * transcripts when the user has them. Best-effort: with no matching context the
 * model still answers, flagging that it is general knowledge.
 */
export async function answerQuestion(
  db: SqlClient,
  model: ModelService,
  opts: { question: string; courseId?: string; embedder?: Embedder },
): Promise<ChatAnswer> {
  const question = opts.question.trim();
  if (!question) return { answer: '', sources: [] };

  const [primers, materials, chunks] = await Promise.all([
    retrievePrimers(db, opts.embedder, question, opts.courseId, 6),
    searchMaterials(db, question, opts.courseId, 3),
    fullTextSearch(db, question, { courseId: opts.courseId, limit: 3 }),
  ]);

  const sources: ChatSource[] = [];
  const blocks: string[] = [];
  let used = 0;

  const push = (label: string, title: string, body: string, type: ChatSource['type']): void => {
    if (used >= TOTAL_CONTEXT_CHARS) return;
    const snippet = body.slice(0, Math.min(PER_SNIPPET_CHARS, TOTAL_CONTEXT_CHARS - used)).trim();
    if (!snippet) return;
    blocks.push(`[${label}] ${title}\n${snippet}`);
    // Cap the snippet shown to the client so citations can reveal the passage
    // without shipping a whole chunk.
    sources.push({ type, title, snippet: snippet.slice(0, 500) });
    used += snippet.length;
  };

  primers.forEach((p, i) =>
    push(`P${i + 1}`, [p.source_title, p.section].filter(Boolean).join(' - ') || 'Primer', p.text, 'primer'),
  );
  materials.forEach((m, i) => push(`M${i + 1}`, m.title ?? m.kind, m.text, 'material'));
  chunks.forEach((c, i) => push(`L${i + 1}`, 'Lecture transcript', c.text, 'lecture'));

  const context = blocks.length > 0 ? blocks.join('\n\n') : '(no matching course material found)';
  const messages: ModelMessage[] = [
    { role: 'system', content: CHAT_SYSTEM },
    { role: 'user', content: `CONTEXT:\n${context}\n\nQUESTION: ${question}` },
  ];
  const res = await model.generate({ messages, maxTokens: 1000 });
  return { answer: res.text.trim(), sources };
}

import type { SqlClient } from '../db/client.js';
import type { ModelMessage } from '../model/provider.js';
import type { ModelService } from '../model/service.js';
import { fullTextSearch } from '../retrieval/search.js';

/**
 * On-device study chat. The student asks a free-form question and gets an answer
 * grounded in THEIR OWN course materials and lecture transcripts, retrieved by
 * full-text search (the same course-scoped, keyword-retrieval idea prep uses -
 * embeddings are not populated in practice). The model is told to answer from
 * the retrieved context and to say when the answer is not in their materials.
 */

export interface ChatSource {
  type: 'material' | 'lecture';
  title: string;
}

export interface ChatAnswer {
  answer: string;
  sources: ChatSource[];
}

/** Per-snippet and total context budgets, so a long reading can't crowd out the rest. */
const PER_SNIPPET_CHARS = 2000;
const TOTAL_CONTEXT_CHARS = 12000;

interface MaterialHit {
  title: string | null;
  kind: string;
  text: string;
}

/** Full-text search over course materials (readings/cases/slides). */
async function searchMaterials(
  db: SqlClient,
  query: string,
  courseId: string | undefined,
  limit: number,
): Promise<MaterialHit[]> {
  const { rows } = await db.query<MaterialHit>(
    `SELECT title, kind, left(text, $4) AS text
     FROM materials
     WHERE tsv @@ plainto_tsquery('english', $1)
       AND length(text) >= 20
       AND ($2::uuid IS NULL OR course_id = $2::uuid)
     ORDER BY ts_rank(tsv, plainto_tsquery('english', $1)) DESC
     LIMIT $3`,
    [query, courseId ?? null, limit, PER_SNIPPET_CHARS],
  );
  return rows;
}

const CHAT_SYSTEM = [
  "You are the student's study assistant inside their class app. Answer the question using the",
  'CONTEXT below, which is drawn from their own course materials and lecture notes. Prefer the',
  'context; cite what you used by its bracketed label (e.g. [M1], [L2]). If the context does not',
  'contain the answer, say so plainly, then you may answer briefly from general knowledge and flag',
  'that it is not from their materials. Be concise and specific. Do not use em dashes.',
].join(' ');

/**
 * Answer a question grounded in the student's materials + lectures. Retrieval is
 * best-effort: with no matching context the model still answers (flagging that it
 * is general knowledge). Returns the answer and the sources that were fed in.
 */
export async function answerQuestion(
  db: SqlClient,
  model: ModelService,
  opts: { question: string; courseId?: string },
): Promise<ChatAnswer> {
  const question = opts.question.trim();
  if (!question) return { answer: '', sources: [] };

  const [materials, chunks] = await Promise.all([
    searchMaterials(db, question, opts.courseId, 4),
    fullTextSearch(db, question, { courseId: opts.courseId, limit: 4 }),
  ]);

  const sources: ChatSource[] = [];
  const blocks: string[] = [];
  let used = 0;

  const push = (label: string, title: string, body: string, type: ChatSource['type']): void => {
    if (used >= TOTAL_CONTEXT_CHARS) return;
    const snippet = body.slice(0, Math.min(PER_SNIPPET_CHARS, TOTAL_CONTEXT_CHARS - used)).trim();
    if (!snippet) return;
    blocks.push(`[${label}] ${title}\n${snippet}`);
    sources.push({ type, title });
    used += snippet.length;
  };

  materials.forEach((m, i) => push(`M${i + 1}`, m.title ?? m.kind, m.text, 'material'));
  chunks.forEach((c, i) => push(`L${i + 1}`, 'Lecture transcript', c.text, 'lecture'));

  const context = blocks.length > 0 ? blocks.join('\n\n') : '(no matching course material found)';
  const messages: ModelMessage[] = [
    { role: 'system', content: CHAT_SYSTEM },
    { role: 'user', content: `CONTEXT:\n${context}\n\nQUESTION: ${question}` },
  ];
  const res = await model.generate({ messages, maxTokens: 800 });
  return { answer: res.text.trim(), sources };
}

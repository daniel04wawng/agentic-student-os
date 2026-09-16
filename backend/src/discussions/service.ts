import { z } from 'zod';
import { invalidateStaleApprovals, isApproved } from '../approval/approval.js';
import { setSessionPlans } from '../classprep/schedule.js';
import type { SqlClient } from '../db/client.js';
import type { ModelMessage } from '../model/provider.js';
import type { ModelService } from '../model/service.js';

/**
 * Canvas "Discussion Posts" (DP0, DP1, ...) are how some Ivey courses (e.g.
 * Programming) deliver per-class prep questions AND graded, submitted work.
 * This module ingests them as assignments (so they can be drafted), feeds their
 * questions into class prep, and drafts an answer the student reviews and posts.
 */

export interface DiscussionAuth {
  baseUrl: string;
  token: string;
}

interface RawDiscussion {
  id: number;
  title: string;
  message?: string | null;
  html_url?: string | null;
  assignment?: { id?: number; due_at?: string | null } | null;
  lock_at?: string | null;
  todo_date?: string | null;
}

/** Strip HTML to readable text. */
function toText(html: string): string {
  return html
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|h\d|ul|ol)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Pull the prep questions out of a discussion prompt. Ivey labels them CP1, CP2,
 * ... (Class Prep). Falls back to "?"-terminated sentences when unlabeled.
 */
export function extractPrepQuestions(bodyText: string): string[] {
  // Scope to after the "Class Prep Questions:" heading (with its colon, so the
  // instruction phrase and the inline "(e.g., CP1, CP2)" mention aren't picked up).
  const head = /class\s+prep\s+questions\s*:/i.exec(bodyText);
  const scope = head ? bodyText.slice(head.index + head[0].length) : bodyText;
  const labeled = [...scope.matchAll(/\bCP\d+\s*[:.)-]?\s*(.+?)(?=\s*[-\s]*\bCP\d+\b|\bEnd your post\b|$)/gis)].map((m) =>
    m[1]!
      .replace(/\s+/g, ' ')
      .replace(/^[-\s]+|[-\s]+$/g, '')
      .trim(),
  );
  const items =
    labeled.length > 0 ? labeled : [...scope.matchAll(/([A-Z][^?]{10,240}\?)/g)].map((m) => m[1]!.trim());
  const seen = new Set<string>();
  return items.filter((q) => q.length >= 10 && !seen.has(q) && (seen.add(q), true)).slice(0, 10);
}

async function fetchDiscussions(auth: DiscussionAuth, canvasCourseId: number, fetchImpl = fetch): Promise<RawDiscussion[]> {
  const res = await fetchImpl(
    `${auth.baseUrl}/api/v1/courses/${canvasCourseId}/discussion_topics?per_page=100`,
    { headers: { Authorization: `Bearer ${auth.token}` } },
  );
  if (!res.ok) return [];
  const list = (await res.json()) as RawDiscussion[];
  return Array.isArray(list) ? list : [];
}

/**
 * Ingest a course's graded discussions as assignments and feed their prep
 * questions into class prep (session_plans keyed by due date). Idempotent on
 * (source, source_id). Returns the number of discussions ingested. Best-effort.
 */
export async function ingestDiscussions(
  db: SqlClient,
  auth: DiscussionAuth,
  canvasCourseId: number,
  courseId: string,
  fetchImpl = fetch,
): Promise<number> {
  const discussions = await fetchDiscussions(auth, canvasCourseId, fetchImpl);
  const plans: Record<string, { topic: string | null; readings: string[]; questions: string[]; caseTitle: string | null }> = {};
  let n = 0;
  for (const d of discussions) {
    if (!d.message) continue; // announcements / empty topics carry no prep
    const body = toText(d.message);
    const dueAt = d.assignment?.due_at ?? d.lock_at ?? d.todo_date ?? null;
    // A GRADED discussion is also ingested as an assignment (source_id = its
    // Canvas assignment id). Merge the discussion_id into that canonical row so
    // there's one assignment and submit knows which forum to post to. Only an
    // UNGRADED discussion (no linked assignment) becomes its own row.
    const assignmentSourceId = d.assignment?.id ? String(d.assignment.id) : `discussion:${d.id}`;
    const merge = { type: 'discussion', discussion_id: d.id };
    const upd = await db.query<{ id: string }>(
      `UPDATE assignments SET description = $1, source_url = COALESCE(source_url, $2),
              metadata = metadata || $3::jsonb
       WHERE source = 'canvas' AND source_id = $4 RETURNING id`,
      [body, d.html_url ?? null, JSON.stringify(merge), assignmentSourceId],
    );
    if (upd.rows.length === 0) {
      await db.query(
        `INSERT INTO assignments (course_id, title, description, status, due_at, source, source_id, source_url, metadata)
         VALUES ($1,$2,$3,'not_started',$4,'canvas'::provider,$5,$6, $7::jsonb)
         ON CONFLICT (source, source_id) WHERE source_id IS NOT NULL DO UPDATE
           SET title = excluded.title, description = excluded.description, due_at = excluded.due_at,
               source_url = excluded.source_url, metadata = assignments.metadata || excluded.metadata`,
        [courseId, d.title, body, dueAt, assignmentSourceId, d.html_url ?? null, JSON.stringify(merge)],
      );
    }
    n += 1;
    // Feed prep: this discussion's questions become the plan for its due date.
    if (dueAt) {
      const date = new Date(dueAt).toISOString().slice(0, 10);
      plans[date] = { topic: d.title, readings: [], questions: extractPrepQuestions(body), caseTitle: null };
    }
  }
  if (Object.keys(plans).length > 0) await setSessionPlans(db, courseId, plans);
  return n;
}

export const DiscussionDraftSchema = z.object({
  /** The full post body to submit, answering each prep question with its label. */
  post: z.string().default(''),
});

const DRAFT_SYSTEM = [
  'You are drafting a student\'s pre-class discussion post for review. Answer every',
  'class-prep question in the prompt, keeping each answer labeled (e.g. "CP1:", "CP2:")',
  'exactly as the prompt asks. Be correct, specific, and concise - a student\'s own',
  'voice, not an essay. Do not use em dashes.',
  'If the prompt requires an AI-use declaration, END the post with a clear declaration',
  'that AI (this assistant) was used to draft it, listing what it did. Never claim the',
  'work was unaided. Output JSON {"post": "..."}.',
].join(' ');

/**
 * Draft an answer to a discussion assignment and store it as a review-ready text
 * artifact (no Google Doc needed - a discussion post is plain text). The student
 * reviews and approves before it is ever posted. Returns the artifact id.
 */
export async function draftDiscussion(
  db: SqlClient,
  model: ModelService,
  assignmentId: string,
): Promise<{ artifactId: string }> {
  const a = await db.query<{ title: string; description: string | null; course_id: string }>(
    `SELECT title, description, course_id FROM assignments WHERE id = $1`,
    [assignmentId],
  );
  if (a.rows.length === 0) throw new Error(`assignment not found: ${assignmentId}`);
  const { title, description } = a.rows[0]!;

  await db.query(`UPDATE assignments SET status = 'generating' WHERE id = $1`, [assignmentId]);

  const messages: ModelMessage[] = [
    { role: 'system', content: DRAFT_SYSTEM },
    { role: 'user', content: `PROMPT: ${title}\n\n${description ?? ''}` },
  ];
  const draft = await model.generateStructured({ messages, maxTokens: 1500 }, DiscussionDraftSchema, {
    fallback: () => ({ post: '' }),
  });

  // A deliverable to attach the artifact to (idempotent per assignment).
  const deliverableId =
    (await db.query<{ id: string }>(`SELECT id FROM deliverables WHERE assignment_id = $1 LIMIT 1`, [assignmentId]))
      .rows[0]?.id ??
    (
      await db.query<{ id: string }>(
        `INSERT INTO deliverables (assignment_id, title, kind) VALUES ($1,$2,'other') RETURNING id`,
        [assignmentId, title],
      )
    ).rows[0]!.id;

  // Store the draft text inline (kind='text'); no external doc. review_ready.
  const artifact = await db.query<{ id: string }>(
    `INSERT INTO artifacts (deliverable_id, kind, status, remote_version, metadata)
     VALUES ($1,'text','review_ready','1', jsonb_build_object('draft_text',$2::text,'prompt',$3::text))
     RETURNING id`,
    [deliverableId, draft.post, `${title}\n\n${description ?? ''}`],
  );
  const artifactId = artifact.rows[0]!.id;
  await db.query(`UPDATE assignments SET status = 'review_ready' WHERE id = $1`, [assignmentId]);
  return { artifactId };
}

/**
 * Edit the current draft's text (the student revising before approving/posting).
 * Advances the artifact's remote_version so any prior approval of the OLD text is
 * invalidated - you cannot silently post text that was never re-reviewed. Returns
 * the new version and the (now always false) approval state. Idempotent-safe:
 * every save bumps the version, so the approval gate always reflects this text.
 */
export async function updateDiscussionDraft(
  db: SqlClient,
  assignmentId: string,
  newText: string,
): Promise<{ artifactId: string; version: string; approved: boolean } | null> {
  const found = await db.query<{ id: string; remote_version: string | null }>(
    `SELECT ar.id, ar.remote_version
     FROM assignments a
     JOIN deliverables d ON d.assignment_id = a.id
     JOIN artifacts ar ON ar.deliverable_id = d.id
     WHERE a.id = $1 AND ar.kind = 'text'
     ORDER BY ar.version DESC LIMIT 1`,
    [assignmentId],
  );
  const cur = found.rows[0];
  if (!cur) return null; // nothing drafted yet - nothing to edit

  const nextVersion = String((Number(cur.remote_version) || 1) + 1);
  await db.query(
    `UPDATE artifacts
       SET metadata = metadata || jsonb_build_object('draft_text', $2::text),
           remote_version = $3,
           version = version + 1,
           status = 'review_ready'
     WHERE id = $1`,
    [cur.id, newText, nextVersion],
  );
  // The version moved, so any active approval no longer matches -> invalidate it.
  await invalidateStaleApprovals(db, cur.id);
  // A submitted assignment that gets re-edited returns to review (needs re-approval).
  await db.query(`UPDATE assignments SET status = 'review_ready' WHERE id = $1 AND status <> 'submitted'`, [assignmentId]);
  return { artifactId: cur.id, version: nextVersion, approved: false };
}

/**
 * Draft answers for discussion assignments due soon that don't have a draft yet.
 * Runs in a scheduled tick (model-heavy). Returns how many were drafted. Never
 * submits - drafts land as review_ready for the student to approve.
 */
export async function draftPendingDiscussions(
  db: SqlClient,
  model: ModelService,
  opts: { now: string; withinHours: number },
): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT a.id FROM assignments a
     WHERE a.metadata->>'type' = 'discussion'
       AND a.status IN ('not_started','planning','context_ready')
       AND a.due_at IS NOT NULL
       AND a.due_at >= $1::timestamptz
       AND a.due_at <= $1::timestamptz + ($2 || ' hours')::interval
       AND NOT EXISTS (SELECT 1 FROM deliverables d JOIN artifacts ar ON ar.deliverable_id = d.id
                       WHERE d.assignment_id = a.id AND ar.kind = 'text')
     ORDER BY a.due_at`,
    [opts.now, String(opts.withinHours)],
  );
  let drafted = 0;
  for (const a of rows) {
    try {
      await draftDiscussion(db, model, a.id);
      drafted += 1;
    } catch {
      // one failure must not block the rest; the assignment stays draftable
    }
  }
  return drafted;
}

export type SubmitDiscussionResult =
  | { status: 'refused'; reason: string }
  | { status: 'dry_run'; post: string }
  | { status: 'submitted'; entryId: string };

/**
 * Post a drafted discussion reply to Canvas - but ONLY after the student has
 * approved the exact draft (the approval gate). Never posts an un-approved or
 * edited-since-approval draft. With `dryRun`, returns what it WOULD post without
 * touching Canvas. This is an irreversible, graded action, so the guard is hard.
 */
export async function submitDiscussion(
  db: SqlClient,
  auth: DiscussionAuth,
  assignmentId: string,
  opts: { dryRun?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<SubmitDiscussionResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const row = await db.query<{
    artifact_id: string;
    draft_text: string | null;
    discussion_id: number | null;
    canvas_course_id: string | null;
  }>(
    `SELECT ar.id AS artifact_id, ar.metadata->>'draft_text' AS draft_text,
            (a.metadata->>'discussion_id')::int AS discussion_id, c.source_id AS canvas_course_id
     FROM assignments a
     JOIN deliverables d ON d.assignment_id = a.id
     JOIN artifacts ar ON ar.deliverable_id = d.id
     JOIN courses c ON c.id = a.course_id
     WHERE a.id = $1 AND ar.kind = 'text'
     ORDER BY ar.version DESC LIMIT 1`,
    [assignmentId],
  );
  const r = row.rows[0];
  if (!r) return { status: 'refused', reason: 'no draft to submit' };
  if (!r.draft_text || r.draft_text.trim().length === 0) return { status: 'refused', reason: 'empty draft' };
  if (!r.discussion_id || !r.canvas_course_id) return { status: 'refused', reason: 'not a Canvas discussion' };

  // The hard gate: an active approval for THIS exact artifact version must exist.
  if (!(await isApproved(db, r.artifact_id))) {
    return { status: 'refused', reason: 'not approved (approve the current draft first)' };
  }

  if (opts.dryRun) return { status: 'dry_run', post: r.draft_text };

  const res = await fetchImpl(
    `${auth.baseUrl}/api/v1/courses/${r.canvas_course_id}/discussion_topics/${r.discussion_id}/entries`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: r.draft_text }),
    },
  );
  if (!res.ok) return { status: 'refused', reason: `Canvas rejected the post (${res.status})` };
  const entry = (await res.json()) as { id?: number | string };

  await db.query(
    `INSERT INTO submissions (assignment_id, artifact_id, status, canvas_submission_id, verified, submitted_at)
     VALUES ($1,$2,'submitted',$3,true, now())
     ON CONFLICT (assignment_id) DO UPDATE
       SET status='submitted', canvas_submission_id=excluded.canvas_submission_id, verified=true, submitted_at=now()`,
    [assignmentId, r.artifact_id, String(entry.id ?? '')],
  );
  await db.query(`UPDATE assignments SET status = 'submitted' WHERE id = $1`, [assignmentId]);
  return { status: 'submitted', entryId: String(entry.id ?? '') };
}

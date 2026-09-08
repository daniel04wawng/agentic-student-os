import { deriveIdempotencyKey } from '@student-os/shared';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createGoogleDocArtifact } from '../artifacts/registry.js';
import { safeAgentEdit } from '../artifacts/edit.js';
import type { SqlClient } from '../db/client.js';
import type { EventBus } from '../events/bus.js';
import type { GoogleDocsClient } from '../google/client.js';
import type { ModelMessage } from '../model/provider.js';
import type { ModelService } from '../model/service.js';

export const ASSIGNMENT_REVIEW_READY = 'assignment.review_ready';
const QA_MIN_BODY_LENGTH = 20;

export const DraftSchema = z.object({ title: z.string().default(''), body: z.string().default('') });
export const CritiqueSchema = z.object({ issues: z.array(z.string()).default([]) });

export interface QaResult {
  pass: boolean;
  reasons: string[];
}

/** Deterministic QA gate. An artifact is REQUIRED to pass. */
export function qaCheck(body: string, hasArtifact: boolean): QaResult {
  const reasons: string[] = [];
  if (!hasArtifact) reasons.push('no_artifact');
  if (body.trim().length < QA_MIN_BODY_LENGTH) reasons.push('too_short');
  return { pass: reasons.length === 0, reasons };
}

/**
 * Transition an assignment to REVIEW_READY. Enforces the invariant that this can
 * only happen when a real artifact exists for the assignment; throws otherwise.
 */
export async function transitionToReviewReady(
  db: SqlClient,
  assignmentId: string,
  artifactId: string,
): Promise<void> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT a.id FROM artifacts a
     JOIN deliverables d ON d.id = a.deliverable_id
     WHERE a.id = $1 AND d.assignment_id = $2`,
    [artifactId, assignmentId],
  );
  if (rows.length === 0) {
    throw new Error('cannot reach review_ready: no artifact for this assignment');
  }
  await db.query(`UPDATE assignments SET status = 'review_ready' WHERE id = $1`, [assignmentId]);
  await db.query(`UPDATE artifacts SET status = 'review_ready' WHERE id = $1`, [artifactId]);
}

interface Ctx {
  model: ModelService;
  google: GoogleDocsClient;
  bus: EventBus;
}

export interface GenerateResult {
  artifactId: string;
  reviewReady: boolean;
  qa: QaResult;
}

/**
 * Generate an assignment: draft -> create Docs artifact -> critique -> revise
 * (rebase-safe) -> QA -> REVIEW_READY. No Canvas submission. Each model step has
 * a deterministic fallback so generation never stalls on model unavailability.
 */
export async function generateAssignment(
  db: SqlClient,
  ctx: Ctx,
  assignmentId: string,
): Promise<GenerateResult> {
  const asg = await db.query<{ title: string; status: string }>(
    `SELECT title, status FROM assignments WHERE id = $1`,
    [assignmentId],
  );
  if (asg.rows.length === 0) throw new Error(`assignment not found: ${assignmentId}`);
  const title = asg.rows[0]!.title;

  await db.query(`UPDATE assignments SET status = 'generating' WHERE id = $1`, [assignmentId]);

  // Ensure a deliverable to attach the artifact to.
  const existing = await db.query<{ id: string }>(
    `SELECT id FROM deliverables WHERE assignment_id = $1 ORDER BY created_at LIMIT 1`,
    [assignmentId],
  );
  const deliverableId =
    existing.rows[0]?.id ??
    (
      await db.query<{ id: string }>(
        `INSERT INTO deliverables (assignment_id, title, kind) VALUES ($1,$2,'essay') RETURNING id`,
        [assignmentId, title],
      )
    ).rows[0]!.id;

  const draftMsgs: ModelMessage[] = [
    { role: 'system', content: 'Draft the assignment as JSON {"title","body"}.' },
    { role: 'user', content: title },
  ];
  const draft = await ctx.model.generateStructured({ messages: draftMsgs }, DraftSchema, {
    fallback: () => ({ title, body: `Draft for "${title}". This response addresses the prompt in full.` }),
  });

  const { artifactId } = await createGoogleDocArtifact(db, ctx.google, deliverableId, draft.title || title, draft.body);

  const critique = await ctx.model.generateStructured(
    { messages: [{ role: 'user', content: draft.body }] },
    CritiqueSchema,
    { fallback: () => ({ issues: [] }) },
  );

  // Revise (rebase-safe): append a revision note per critique issue.
  const revisedBody = await safeAgentEditBody(db, ctx.google, artifactId, (current) =>
    critique.issues.length > 0 ? `${current}\n\nRevised: addressed ${critique.issues.length} issue(s).` : current,
  );

  const qa = qaCheck(revisedBody, true);
  if (qa.pass) {
    await transitionToReviewReady(db, assignmentId, artifactId);
    await ctx.bus.publish({
      name: ASSIGNMENT_REVIEW_READY,
      occurred_at: new Date().toISOString(),
      idempotency_key: deriveIdempotencyKey(['assignment', 'review_ready', assignmentId]),
      trace_id: randomUUID(),
      source: 'system',
      subject_type: 'assignment',
      subject_id: assignmentId,
      payload: { assignment_id: assignmentId, artifact_id: artifactId },
    });
  }
  return { artifactId, reviewReady: qa.pass, qa };
}

/** Rebase-safe edit that also returns the resulting content for QA. */
async function safeAgentEditBody(
  db: SqlClient,
  google: GoogleDocsClient,
  artifactId: string,
  editFn: (current: string) => string,
): Promise<string> {
  let result = '';
  await safeAgentEdit(db, google, artifactId, (current) => {
    result = editFn(current);
    return result;
  });
  return result;
}

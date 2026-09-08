import type { SqlClient } from '../db/client.js';
import type { GoogleDocsClient } from '../google/client.js';

export interface ReviewPacket {
  assignment_id: string;
  artifact_id: string;
  artifact_version: number;
  summary: string;
  main_argument: string;
  warnings: string[];
  review_minutes: number;
  artifact_uri: string | null;
  source_links: string[];
}

/** Reading-time based review estimate (~200 wpm) plus a small fixed overhead. */
export function estimateReviewMinutes(wordCount: number): number {
  return Math.max(2, Math.ceil(wordCount / 200) + 2);
}

function firstSentence(text: string): string {
  const m = /[^.!?]*[.!?]/.exec(text.trim());
  return (m ? m[0] : text).trim().slice(0, 240);
}

/**
 * Build (and persist) a review packet for an assignment's REVIEW_READY artifact.
 * Deterministic. Idempotent per (assignment, artifact version).
 */
export async function buildReviewPacket(
  db: SqlClient,
  google: GoogleDocsClient,
  assignmentId: string,
): Promise<ReviewPacket> {
  const { rows } = await db.query<{
    artifact_id: string;
    version: number;
    uri: string | null;
    source_id: string | null;
    source_url: string | null;
  }>(
    `SELECT a.id AS artifact_id, a.version, a.uri, a.source_id, a.source_url
     FROM artifacts a
     JOIN deliverables d ON d.id = a.deliverable_id
     WHERE d.assignment_id = $1 AND a.status = 'review_ready'
     ORDER BY a.updated_at DESC LIMIT 1`,
    [assignmentId],
  );
  if (rows.length === 0) throw new Error(`no review_ready artifact for assignment ${assignmentId}`);
  const art = rows[0]!;

  const content = art.source_id ? await google.getContent(art.source_id) : '';
  const words = (content.match(/\S+/g) ?? []).length;
  const warnings: string[] = [];
  if (words < 100) warnings.push('short_draft');
  if (!art.source_url) warnings.push('no_source_citation');

  const packet: ReviewPacket = {
    assignment_id: assignmentId,
    artifact_id: art.artifact_id,
    artifact_version: art.version,
    summary: content.replace(/\s+/g, ' ').trim().slice(0, 280),
    main_argument: firstSentence(content),
    warnings,
    review_minutes: estimateReviewMinutes(words),
    artifact_uri: art.uri,
    source_links: art.source_url ? [art.source_url] : [],
  };

  await db.query(
    `INSERT INTO review_packets
       (key, assignment_id, artifact_id, artifact_version, summary, main_argument, warnings, review_minutes, artifact_uri, source_links)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10::jsonb)
     ON CONFLICT (key) DO UPDATE SET
       summary=excluded.summary, main_argument=excluded.main_argument, warnings=excluded.warnings,
       review_minutes=excluded.review_minutes, artifact_uri=excluded.artifact_uri, source_links=excluded.source_links`,
    [
      `${assignmentId}:${art.artifact_id}:${art.version}`,
      assignmentId,
      art.artifact_id,
      art.version,
      packet.summary,
      packet.main_argument,
      JSON.stringify(packet.warnings),
      packet.review_minutes,
      packet.artifact_uri,
      JSON.stringify(packet.source_links),
    ],
  );
  return packet;
}

/** Latest stored review packet for an assignment. */
export async function getReviewPacket(db: SqlClient, assignmentId: string): Promise<ReviewPacket | null> {
  const { rows } = await db.query<ReviewPacket>(
    `SELECT assignment_id, artifact_id, artifact_version, summary, main_argument,
            warnings, review_minutes, artifact_uri, source_links
     FROM review_packets WHERE assignment_id = $1 ORDER BY artifact_version DESC LIMIT 1`,
    [assignmentId],
  );
  return rows[0] ?? null;
}

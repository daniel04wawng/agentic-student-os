import { deriveIdempotencyKey } from '@student-os/shared';
import { randomUUID } from 'node:crypto';
import type { SqlClient } from '../db/client.js';
import type { EventBus } from '../events/bus.js';

export const ASSIGNMENT_CONTEXT_READY = 'assignment.context_ready';

export interface Requirement {
  key: string;
  description?: string;
  blocking: boolean;
  resolved: boolean;
}

/** A contract is ready when every BLOCKING requirement is resolved. */
export function isReady(requirements: Requirement[]): boolean {
  return requirements.filter((r) => r.blocking).every((r) => r.resolved);
}

interface ContractRow {
  requirements: Requirement[];
  status: string;
  emitted_ready: boolean;
}

async function loadContract(db: SqlClient, assignmentId: string): Promise<ContractRow | null> {
  const { rows } = await db.query<ContractRow>(
    `SELECT requirements, status, emitted_ready FROM readiness_contracts WHERE assignment_id = $1`,
    [assignmentId],
  );
  return rows[0] ?? null;
}

/** Create (or replace the requirements of) a readiness contract. */
export async function createContract(
  db: SqlClient,
  assignmentId: string,
  requirements: Requirement[],
): Promise<void> {
  await db.query(
    `INSERT INTO readiness_contracts (assignment_id, requirements)
     VALUES ($1, $2::jsonb)
     ON CONFLICT (assignment_id) DO UPDATE SET requirements = excluded.requirements`,
    [assignmentId, JSON.stringify(requirements)],
  );
}

/** Revise a contract with new evidence: add requirements not already present. */
export async function reviseContract(
  db: SqlClient,
  assignmentId: string,
  additions: Requirement[],
): Promise<void> {
  const contract = await loadContract(db, assignmentId);
  const existing = contract?.requirements ?? [];
  const keys = new Set(existing.map((r) => r.key));
  const merged = [...existing, ...additions.filter((r) => !keys.has(r.key))];
  await createContract(db, assignmentId, merged);
}

/**
 * Evaluate readiness. When it becomes ready for the first time, promote the
 * assignment to `context_ready` (only from pre-ready states) and emit
 * `assignment.context_ready` exactly once (bus idempotency).
 */
export async function evaluate(
  db: SqlClient,
  bus: EventBus,
  assignmentId: string,
): Promise<{ ready: boolean }> {
  const contract = await loadContract(db, assignmentId);
  if (!contract) return { ready: false };

  const ready = isReady(contract.requirements);
  await db.query(`UPDATE readiness_contracts SET status = $2 WHERE assignment_id = $1`, [
    assignmentId,
    ready ? 'ready' : 'pending',
  ]);

  if (ready && !contract.emitted_ready) {
    await db.query(
      `UPDATE readiness_contracts SET emitted_ready = true WHERE assignment_id = $1`,
      [assignmentId],
    );
    await db.query(
      `UPDATE assignments SET status = 'context_ready'
       WHERE id = $1 AND status IN ('not_started','planning','context_pending')`,
      [assignmentId],
    );
    await bus.publish({
      name: ASSIGNMENT_CONTEXT_READY,
      occurred_at: new Date().toISOString(),
      idempotency_key: deriveIdempotencyKey(['assignment', 'context_ready', assignmentId]),
      trace_id: randomUUID(),
      source: 'system',
      subject_type: 'assignment',
      subject_id: assignmentId,
      payload: { assignment_id: assignmentId },
    });
  }
  return { ready };
}

/**
 * Resolve every requirement matching `key` across contracts, then re-evaluate
 * only the affected assignments. An event whose key matches nothing changes
 * nothing (no spurious readiness).
 */
export async function resolveByEvidence(
  db: SqlClient,
  bus: EventBus,
  key: string,
): Promise<{ affected: number }> {
  const { rows } = await db.query<{ assignment_id: string; requirements: Requirement[] }>(
    `SELECT assignment_id, requirements FROM readiness_contracts
     WHERE requirements @> $1::jsonb`,
    [JSON.stringify([{ key }])],
  );
  for (const row of rows) {
    const updated = row.requirements.map((r) => (r.key === key ? { ...r, resolved: true } : r));
    await db.query(`UPDATE readiness_contracts SET requirements = $2::jsonb WHERE assignment_id = $1`, [
      row.assignment_id,
      JSON.stringify(updated),
    ]);
    await evaluate(db, bus, row.assignment_id);
  }
  return { affected: rows.length };
}

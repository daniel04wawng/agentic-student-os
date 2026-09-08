import type { SqlClient } from '../db/client.js';
import type { ParsedCommand } from './commands.js';

export type ApplyResult =
  | { status: 'applied'; action: string }
  | { status: 'needs_confirmation'; action: string; reason: string }
  | { status: 'unknown' };

async function upsertState(
  db: SqlClient,
  scope: 'global' | 'course',
  scopeId: string | null,
  patch: { paused?: boolean; policy?: string; deferred_until?: string | null },
): Promise<void> {
  await db.query(
    `INSERT INTO control_state (scope, scope_id, paused, policy, deferred_until)
     VALUES ($1, $2, COALESCE($3, false), $4, $5)
     ON CONFLICT (scope, COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid))
     DO UPDATE SET
       paused = COALESCE($3, control_state.paused),
       policy = COALESCE($4, control_state.policy),
       deferred_until = COALESCE($5, control_state.deferred_until)`,
    [scope, scopeId, patch.paused ?? null, patch.policy ?? null, patch.deferred_until ?? null],
  );
}

/**
 * Apply a parsed control command. Dangerous overrides require `confirmed: true`;
 * otherwise they are refused with a needs_confirmation result (no mutation).
 */
export async function applyCommand(
  db: SqlClient,
  cmd: ParsedCommand,
  opts: { confirmed?: boolean; courseId?: string | null } = {},
): Promise<ApplyResult> {
  if (cmd.action === 'unknown') return { status: 'unknown' };
  if (cmd.dangerous && !opts.confirmed) {
    return { status: 'needs_confirmation', action: cmd.action, reason: 'dangerous_override' };
  }
  const scopeId = cmd.scope === 'course' ? (opts.courseId ?? null) : null;

  switch (cmd.action) {
    case 'pause':
      await upsertState(db, cmd.scope, scopeId, { paused: true });
      break;
    case 'resume':
      await upsertState(db, cmd.scope, scopeId, { paused: false });
      break;
    case 'defer':
      await upsertState(db, cmd.scope, scopeId, { deferred_until: cmd.untilEvent ?? null });
      break;
    case 'set_policy':
      await upsertState(db, cmd.scope, scopeId, { policy: cmd.policy });
      break;
    default:
      return { status: 'unknown' };
  }
  return { status: 'applied', action: cmd.action };
}

/** Effective pause state: course scope OR global scope paused. */
export async function isPaused(db: SqlClient, courseId?: string | null): Promise<boolean> {
  const { rows } = await db.query<{ paused: boolean }>(
    `SELECT paused FROM control_state
     WHERE (scope='global') OR (scope='course' AND scope_id = $1)`,
    [courseId ?? null],
  );
  return rows.some((r) => r.paused);
}

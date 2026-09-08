import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyCommand, isPaused } from '../../src/control/apply.js';
import { parseCommand } from '../../src/control/commands.js';
import { freshDb, resetDb } from '../db/helpers.js';

let db: PGlite;
beforeAll(async () => {
  db = await freshDb();
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await resetDb(db);
});

async function course(sid: string): Promise<string> {
  const c = await db.query<{ id: string }>(
    `INSERT INTO courses (name, source, source_id) VALUES ('C','canvas',$1) RETURNING id`,
    [sid],
  );
  return c.rows[0]!.id;
}

describe('parseCommand', () => {
  it('parses pause/resume/defer/policy with scope', () => {
    expect(parseCommand('pause course CS101')).toMatchObject({ action: 'pause', scope: 'course', courseName: 'cs101' });
    expect(parseCommand('resume')).toMatchObject({ action: 'resume', scope: 'global' });
    expect(parseCommand('defer until context_ready')).toMatchObject({ action: 'defer', untilEvent: 'context_ready' });
    expect(parseCommand('set policy to auto')).toMatchObject({ action: 'set_policy', policy: 'auto', dangerous: true });
    expect(parseCommand('set policy to require_review')).toMatchObject({ policy: 'require_review', dangerous: false });
    expect(parseCommand('do a backflip')).toMatchObject({ action: 'unknown' });
  });
});

describe('applyCommand', () => {
  it('pauses and resumes globally', async () => {
    await applyCommand(db, parseCommand('pause'));
    expect(await isPaused(db)).toBe(true);
    await applyCommand(db, parseCommand('resume'));
    expect(await isPaused(db)).toBe(false);
  });

  it('scopes pause to a single course', async () => {
    const a = await course('a');
    const b = await course('b');
    await applyCommand(db, parseCommand('pause course a'), { courseId: a });
    expect(await isPaused(db, a)).toBe(true);
    expect(await isPaused(db, b)).toBe(false);
  });

  it('requires confirmation for a dangerous override (policy -> auto)', async () => {
    const cmd = parseCommand('set policy to auto');
    const first = await applyCommand(db, cmd);
    expect(first).toMatchObject({ status: 'needs_confirmation', reason: 'dangerous_override' });

    const confirmed = await applyCommand(db, cmd, { confirmed: true });
    expect(confirmed).toMatchObject({ status: 'applied' });
    const { rows } = await db.query<{ policy: string }>(
      `SELECT policy FROM control_state WHERE scope='global'`,
    );
    expect(rows[0]!.policy).toBe('auto');
  });
});

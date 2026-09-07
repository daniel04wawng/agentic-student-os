import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DB_ENUMS, TABLES } from '../../src/db/schema.js';
import { freshDb, insertCourse, resetDb } from './helpers.js';

// Boot PGlite once for the whole file; reset (truncate) between tests. Much
// faster than a fresh instance per test.
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

describe('migration', () => {
  it('creates every canonical table', async () => {
    const res = await db.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
    );
    const present = new Set(res.rows.map((r) => r.tablename));
    for (const t of TABLES) expect(present.has(t)).toBe(true);
  });
});

describe('defaults', () => {
  it('applies course defaults', async () => {
    const id = await insertCourse(db);
    const { rows } = await db.query<{ status: string; source: string; metadata: unknown }>(
      `SELECT status, source, metadata FROM courses WHERE id = $1`,
      [id],
    );
    expect(rows[0]).toMatchObject({ status: 'active', source: 'manual', metadata: {} });
  });

  it('applies artifact defaults (version 1, draft)', async () => {
    const courseId = await insertCourse(db);
    const a = await db.query<{ id: string }>(
      `INSERT INTO assignments (course_id, title) VALUES ($1,'A') RETURNING id`,
      [courseId],
    );
    const d = await db.query<{ id: string }>(
      `INSERT INTO deliverables (assignment_id, title) VALUES ($1,'D') RETURNING id`,
      [a.rows[0]!.id],
    );
    const art = await db.query<{ version: number; status: string }>(
      `INSERT INTO artifacts (deliverable_id) VALUES ($1) RETURNING version, status`,
      [d.rows[0]!.id],
    );
    expect(art.rows[0]).toMatchObject({ version: 1, status: 'draft' });
  });
});

describe('enum constraints', () => {
  it('rejects an invalid enum value', async () => {
    await expect(
      db.query(`INSERT INTO courses (name, status) VALUES ('x', 'bogus')`),
    ).rejects.toThrow();
  });
});

describe('provenance dedup (partial unique on source, source_id)', () => {
  it('rejects a duplicate (source, source_id)', async () => {
    await db.query(`INSERT INTO courses (name, source, source_id) VALUES ('c1','canvas','123')`);
    await expect(
      db.query(`INSERT INTO courses (name, source, source_id) VALUES ('c2','canvas','123')`),
    ).rejects.toThrow();
  });

  it('allows multiple rows with a null source_id', async () => {
    await db.query(`INSERT INTO courses (name, source) VALUES ('c1','manual')`);
    await db.query(`INSERT INTO courses (name, source) VALUES ('c2','manual')`);
    const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM courses`);
    expect(rows[0]!.n).toBe(2);
  });
});

describe('deliverable exactly-one-parent check', () => {
  let courseId: string;
  let assignmentId: string;
  let projectId: string;
  beforeEach(async () => {
    courseId = await insertCourse(db);
    assignmentId = (
      await db.query<{ id: string }>(
        `INSERT INTO assignments (course_id, title) VALUES ($1,'A') RETURNING id`,
        [courseId],
      )
    ).rows[0]!.id;
    projectId = (
      await db.query<{ id: string }>(
        `INSERT INTO projects (course_id, title) VALUES ($1,'P') RETURNING id`,
        [courseId],
      )
    ).rows[0]!.id;
  });

  it('accepts an assignment-only deliverable', async () => {
    await expect(
      db.query(`INSERT INTO deliverables (assignment_id, title) VALUES ($1,'D')`, [assignmentId]),
    ).resolves.toBeDefined();
  });

  it('accepts a project-only deliverable', async () => {
    await expect(
      db.query(`INSERT INTO deliverables (project_id, title) VALUES ($1,'D')`, [projectId]),
    ).resolves.toBeDefined();
  });

  it('rejects a deliverable with both parents', async () => {
    await expect(
      db.query(`INSERT INTO deliverables (assignment_id, project_id, title) VALUES ($1,$2,'D')`, [
        assignmentId,
        projectId,
      ]),
    ).rejects.toThrow();
  });

  it('rejects a deliverable with no parent', async () => {
    await expect(db.query(`INSERT INTO deliverables (title) VALUES ('D')`)).rejects.toThrow();
  });
});

describe('updated_at trigger', () => {
  it('bumps updated_at on UPDATE', async () => {
    // Insert with an explicitly-old updated_at so a bump to now() is unambiguous.
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO courses (name, created_at, updated_at)
       VALUES ('c', '2000-01-01T00:00:00Z', '2000-01-01T00:00:00Z') RETURNING id`,
    );
    await db.query(`UPDATE courses SET name = 'renamed' WHERE id = $1`, [rows[0]!.id]);
    const after = await db.query<{ bumped: boolean }>(
      `SELECT updated_at > timestamptz '2020-01-01' AS bumped FROM courses WHERE id = $1`,
      [rows[0]!.id],
    );
    expect(after.rows[0]!.bumped).toBe(true);
  });
});

describe('deadline source timezone is stored independently of the instant', () => {
  it('round-trips due_at and due_source_timezone separately', async () => {
    const courseId = await insertCourse(db);
    await db.query(
      `INSERT INTO assignments (course_id, title, due_at, due_source_timezone)
       VALUES ($1,'A', timestamptz '2026-05-01T23:59:00-04:00', 'America/New_York')`,
      [courseId],
    );
    const { rows } = await db.query<{ tz: string; has_instant: boolean }>(
      `SELECT due_source_timezone AS tz, (due_at IS NOT NULL) AS has_instant
       FROM assignments WHERE course_id = $1`,
      [courseId],
    );
    expect(rows[0]!.tz).toBe('America/New_York');
    expect(rows[0]!.has_instant).toBe(true);
  });
});

describe('ownership cascade and set-null', () => {
  it('cascades course deletion down to artifacts', async () => {
    const courseId = await insertCourse(db);
    const a = await db.query<{ id: string }>(
      `INSERT INTO assignments (course_id, title) VALUES ($1,'A') RETURNING id`,
      [courseId],
    );
    const d = await db.query<{ id: string }>(
      `INSERT INTO deliverables (assignment_id, title) VALUES ($1,'D') RETURNING id`,
      [a.rows[0]!.id],
    );
    await db.query(`INSERT INTO artifacts (deliverable_id) VALUES ($1)`, [d.rows[0]!.id]);

    await db.query(`DELETE FROM courses WHERE id = $1`, [courseId]);

    for (const table of ['assignments', 'deliverables', 'artifacts']) {
      const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
      expect(rows[0]!.n).toBe(0);
    }
  });

  it('nulls a person course_id when the course is deleted (person survives)', async () => {
    const courseId = await insertCourse(db);
    await db.query(`INSERT INTO people (full_name, course_id) VALUES ('P', $1)`, [courseId]);
    await db.query(`DELETE FROM courses WHERE id = $1`, [courseId]);
    const { rows } = await db.query<{ n: number; nulls: number }>(
      `SELECT count(*)::int AS n, count(*) FILTER (WHERE course_id IS NULL)::int AS nulls FROM people`,
    );
    expect(rows[0]).toMatchObject({ n: 1, nulls: 1 });
  });
});

describe('enum drift guard', () => {
  it('TS enum mirrors exactly match DB enum labels (name, values, order)', async () => {
    const { rows } = await db.query<{ name: string; label: string }>(
      `SELECT t.typname AS name, e.enumlabel AS label
       FROM pg_type t
       JOIN pg_enum e ON e.enumtypid = t.oid
       JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = 'public'
       ORDER BY t.typname, e.enumsortorder`,
    );
    const fromDb: Record<string, string[]> = {};
    for (const { name, label } of rows) (fromDb[name] ??= []).push(label);

    const expected = Object.fromEntries(
      Object.entries(DB_ENUMS).map(([k, v]) => [k, [...v]]),
    );
    expect(fromDb).toEqual(expected);
  });
});

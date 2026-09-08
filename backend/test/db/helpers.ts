import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

/**
 * Apply the canonical SQL migrations to a fresh in-memory PGlite instance.
 * PGlite is real Postgres compiled to WASM, so the DDL runs exactly as it will
 * on Supabase, with no Docker. Each test gets its own isolated database.
 */
const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'supabase',
  'migrations',
);

export async function freshDb(): Promise<PGlite> {
  const db = new PGlite();
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    await db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
  }
  return db;
}

/**
 * Truncate all domain tables between tests. Booting PGlite is expensive
 * (seconds); this lets a suite boot once and reset cheaply per test.
 */
export async function resetDb(db: PGlite): Promise<void> {
  await db.exec(
    `TRUNCATE courses, people, sessions, assignments, projects,
             deliverables, artifacts, admin_items, events, course_profiles,
             devices, notifications, recordings, transcripts, transcript_chunks,
             summaries, readiness_contracts, class_preps, writing_samples, review_packets, approvals, submissions, control_state
     RESTART IDENTITY CASCADE`,
  );
}

/** Insert a minimal course and return its id. */
export async function insertCourse(db: PGlite, name = 'CS101'): Promise<string> {
  const res = await db.query<{ id: string }>(
    `INSERT INTO courses (name) VALUES ($1) RETURNING id`,
    [name],
  );
  return res.rows[0]!.id;
}

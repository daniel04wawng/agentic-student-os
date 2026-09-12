import type { SqlClient } from '../db/client.js';
import type { CaseSegment } from '../materials/split.js';

/** One row of a course's outline schedule: a class date and its assigned case. */
export interface ScheduleEntry {
  /** Class date, ISO 'YYYY-MM-DD'. */
  date: string;
  /** The case title as written in the outline (matched fuzzily to a coursepack case). */
  caseTitle: string;
}

/** Alphanumeric word tokens, lowercased, for fuzzy title matching. */
function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2), // drop "a", "of", "in", "the"-ish noise
  );
}

/** Jaccard-ish overlap of two token sets, in [0, 1]. */
function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

/**
 * Match each schedule entry's case title to a case in the split coursepack and
 * return a { date -> 0-based case index } map. Only confident matches are kept
 * (so an unmatched outline line falls back to order-based, never a wrong case).
 */
export function matchScheduleToCases(
  cases: CaseSegment[],
  entries: ScheduleEntry[],
  minScore = 0.5,
): Record<string, number> {
  const caseTokens = cases.map((c) => tokens(c.title));
  const out: Record<string, number> = {};
  for (const entry of entries) {
    const et = tokens(entry.caseTitle);
    let bestIdx = -1;
    let best = 0;
    for (let i = 0; i < caseTokens.length; i += 1) {
      const score = overlap(et, caseTokens[i]!);
      if (score > best) {
        best = score;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0 && best >= minScore) out[entry.date] = bestIdx;
  }
  return out;
}

/**
 * Persist a course's exact date -> case-index schedule into the course profile
 * (merged into profile.case_schedule), where prep reads it to assign each class
 * its outline-specified case. Idempotent per course.
 */
export async function setCaseSchedule(
  db: SqlClient,
  courseId: string,
  dateToIndex: Record<string, number>,
): Promise<void> {
  await db.query(
    `INSERT INTO course_profiles (course_id, profile)
     VALUES ($1, jsonb_build_object('case_schedule', $2::jsonb))
     ON CONFLICT (course_id) DO UPDATE
       SET profile = course_profiles.profile || jsonb_build_object('case_schedule', $2::jsonb)`,
    [courseId, JSON.stringify(dateToIndex)],
  );
}

/** The professor's plan for one class date, as prep consumes it. */
export interface StoredSessionPlan {
  topic: string | null;
  readings: string[];
  questions: string[];
  caseTitle: string | null;
}

/**
 * Persist a course's per-date session plans (topic / readings / study questions
 * / case) into the course profile, where prep reads them to make each class's
 * prep session-specific and to prep against the professor's own questions.
 */
export async function setSessionPlans(
  db: SqlClient,
  courseId: string,
  dateToPlan: Record<string, StoredSessionPlan>,
): Promise<void> {
  await db.query(
    `INSERT INTO course_profiles (course_id, profile)
     VALUES ($1, jsonb_build_object('session_plans', $2::jsonb))
     ON CONFLICT (course_id) DO UPDATE
       SET profile = course_profiles.profile || jsonb_build_object('session_plans', $2::jsonb)`,
    [courseId, JSON.stringify(dateToPlan)],
  );
}

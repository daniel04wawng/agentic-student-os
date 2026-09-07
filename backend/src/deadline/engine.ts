/**
 * Deadline / timezone engine (PR 6). Pure, deterministic reasoning about
 * deadlines. Canvas gives an absolute instant (UTC); the SOURCE timezone (the
 * course's tz) is preserved separately from the DEVICE ("current iPhone")
 * timezone so we can display both and detect mismatches. Uses the Intl API,
 * which is DST-correct.
 */

export interface ZonedDisplay {
  timezone: string;
  /** Wall-clock time in that zone, "YYYY-MM-DD HH:mm". */
  wall_clock: string;
  /** UTC offset at that instant, e.g. "-04:00" (DST-aware). */
  offset: string;
}

export type TimezoneResolution = 'explicit' | 'course_fallback' | 'unknown';

export interface ResolvedDeadline {
  has_deadline: boolean;
  instant_utc: string | null;
  source: {
    timezone: string | null;
    resolution: TimezoneResolution;
    display: ZonedDisplay | null;
  };
  current: ZonedDisplay;
  /** Set when the stored source tz disagrees with the course tz. */
  source_mismatch: { stored_timezone: string; course_timezone: string } | null;
}

/** UTC offset like "-04:00" for an instant in a zone (DST-aware); "+00:00" for UTC. */
export function zoneOffset(instant: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    timeZoneName: 'longOffset',
  }).formatToParts(instant);
  const name = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const off = name.replace('GMT', '').trim();
  return off === '' ? '+00:00' : off;
}

/** Wall-clock "YYYY-MM-DD HH:mm" for an instant in a zone. */
export function wallClockInZone(instant: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(instant);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  // en-CA hour can render "24" at midnight in some engines; normalize to "00".
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${get('year')}-${get('month')}-${get('day')} ${hour}:${get('minute')}`;
}

export function formatInZone(instant: Date, timezone: string): ZonedDisplay {
  return { timezone, wall_clock: wallClockInZone(instant, timezone), offset: zoneOffset(instant, timezone) };
}

export interface ResolveInput {
  dueAt: string | null;
  sourceTimezone: string | null;
  courseTimezone?: string | null;
  currentTimezone: string;
}

export function resolveDeadline(input: ResolveInput): ResolvedDeadline {
  const { dueAt, sourceTimezone, courseTimezone, currentTimezone } = input;

  if (!dueAt) {
    return {
      has_deadline: false,
      instant_utc: null,
      source: { timezone: sourceTimezone ?? courseTimezone ?? null, resolution: 'unknown', display: null },
      current: { timezone: currentTimezone, wall_clock: '', offset: '' },
      source_mismatch: null,
    };
  }

  const instant = new Date(dueAt);
  const instantUtc = instant.toISOString();

  let timezone: string | null;
  let resolution: TimezoneResolution;
  if (sourceTimezone) {
    timezone = sourceTimezone;
    resolution = 'explicit';
  } else if (courseTimezone) {
    timezone = courseTimezone;
    resolution = 'course_fallback';
  } else {
    timezone = null;
    resolution = 'unknown';
  }

  const source_mismatch =
    sourceTimezone && courseTimezone && sourceTimezone !== courseTimezone
      ? { stored_timezone: sourceTimezone, course_timezone: courseTimezone }
      : null;

  return {
    has_deadline: true,
    instant_utc: instantUtc,
    source: {
      timezone,
      resolution,
      display: timezone ? formatInZone(instant, timezone) : null,
    },
    current: formatInZone(instant, currentTimezone),
    source_mismatch,
  };
}

export interface DeadlineItem {
  id: string;
  dueAt: string;
}

export interface DeadlineConflict {
  a: string;
  b: string;
  gap_minutes: number;
}

/**
 * Conservative conflict reasoning: flag any pair of deadlines whose absolute
 * instants fall within `windowMinutes` of each other. Conservative = surface
 * potential clashes rather than risk missing them; the agent decides what to do.
 */
export function findDeadlineConflicts(
  items: DeadlineItem[],
  windowMinutes: number,
): DeadlineConflict[] {
  const sorted = [...items].sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
  const windowMs = windowMinutes * 60_000;
  const conflicts: DeadlineConflict[] = [];
  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) {
      const gap = Date.parse(sorted[j]!.dueAt) - Date.parse(sorted[i]!.dueAt);
      if (gap > windowMs) break; // sorted: no later item can be closer
      conflicts.push({ a: sorted[i]!.id, b: sorted[j]!.id, gap_minutes: Math.round(gap / 60_000) });
    }
  }
  return conflicts;
}

import { describe, expect, it } from 'vitest';
import {
  findDeadlineConflicts,
  formatInZone,
  resolveDeadline,
  wallClockInZone,
  zoneOffset,
} from '../../src/deadline/engine.js';

describe('DST-aware zone conversion', () => {
  it('reflects EDT vs EST across the DST boundary', () => {
    const summer = new Date('2026-07-01T12:00:00Z');
    const winter = new Date('2026-01-01T12:00:00Z');
    expect(zoneOffset(summer, 'America/New_York')).toBe('-04:00'); // EDT
    expect(zoneOffset(winter, 'America/New_York')).toBe('-05:00'); // EST
  });

  it('renders the classic "11:59pm ET stored as next-day UTC" case', () => {
    // May 1 03:59 UTC == Apr 30 23:59 in New York (EDT).
    expect(wallClockInZone(new Date('2026-05-01T03:59:00Z'), 'America/New_York')).toBe(
      '2026-04-30 23:59',
    );
  });

  it('shows different wall clocks for the same instant across zones (travel)', () => {
    const instant = new Date('2026-05-01T03:59:00Z');
    const ny = formatInZone(instant, 'America/New_York');
    const tokyo = formatInZone(instant, 'Asia/Tokyo');
    expect(ny.wall_clock).not.toBe(tokyo.wall_clock);
    expect(tokyo.offset).toBe('+09:00');
  });
});

describe('resolveDeadline', () => {
  const currentTimezone = 'America/Los_Angeles';

  it('uses an explicit source timezone', () => {
    const r = resolveDeadline({
      dueAt: '2026-05-01T03:59:00Z',
      sourceTimezone: 'America/New_York',
      currentTimezone,
    });
    expect(r.has_deadline).toBe(true);
    expect(r.source.resolution).toBe('explicit');
    expect(r.source.display?.wall_clock).toBe('2026-04-30 23:59');
    expect(r.current.timezone).toBe(currentTimezone);
  });

  it('falls back to the course timezone when the source is missing', () => {
    const r = resolveDeadline({
      dueAt: '2026-05-01T03:59:00Z',
      sourceTimezone: null,
      courseTimezone: 'America/New_York',
      currentTimezone,
    });
    expect(r.source.resolution).toBe('course_fallback');
    expect(r.source.timezone).toBe('America/New_York');
  });

  it('reports unknown when neither is available', () => {
    const r = resolveDeadline({ dueAt: '2026-05-01T03:59:00Z', sourceTimezone: null, currentTimezone });
    expect(r.source.resolution).toBe('unknown');
    expect(r.source.display).toBeNull();
  });

  it('flags a source/course timezone mismatch', () => {
    const r = resolveDeadline({
      dueAt: '2026-05-01T03:59:00Z',
      sourceTimezone: 'America/Chicago',
      courseTimezone: 'America/New_York',
      currentTimezone,
    });
    expect(r.source_mismatch).toEqual({
      stored_timezone: 'America/Chicago',
      course_timezone: 'America/New_York',
    });
  });

  it('handles a missing deadline', () => {
    const r = resolveDeadline({ dueAt: null, sourceTimezone: null, currentTimezone });
    expect(r.has_deadline).toBe(false);
    expect(r.instant_utc).toBeNull();
  });
});

describe('findDeadlineConflicts', () => {
  it('flags deadlines within the window and ignores distant ones', () => {
    const conflicts = findDeadlineConflicts(
      [
        { id: 'a', dueAt: '2026-05-01T10:00:00Z' },
        { id: 'b', dueAt: '2026-05-01T10:30:00Z' }, // 30 min after a
        { id: 'c', dueAt: '2026-05-01T20:00:00Z' }, // far
      ],
      60,
    );
    expect(conflicts).toEqual([{ a: 'a', b: 'b', gap_minutes: 30 }]);
  });
});

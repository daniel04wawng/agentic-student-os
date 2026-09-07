import { describe, expect, it } from 'vitest';
import { buildCourseProfile, buildPlanningSummary, htmlToExcerpt } from '../../src/onboarding/profile.js';

describe('htmlToExcerpt', () => {
  it('strips tags, collapses whitespace, and truncates', () => {
    expect(htmlToExcerpt('<p>Hello   <b>world</b></p>')).toBe('Hello world');
    expect(htmlToExcerpt('<p>' + 'a'.repeat(1000) + '</p>', 10)).toBe(`${'a'.repeat(10)}...`);
    expect(htmlToExcerpt(null)).toBeNull();
  });
});

describe('buildCourseProfile', () => {
  it('aggregates counts, titles, and syllabus excerpt', () => {
    const profile = buildCourseProfile({
      course: { id: 1, name: 'CS101', course_code: 'CS-1', time_zone: 'America/New_York', syllabus_body: '<p>Read chapter 1</p>' },
      assignments: [{ id: 1, course_id: 1, name: 'HW1' }],
      modules: [{ id: 1, name: 'Intro' }, { id: 2, name: 'Week 2' }],
      announcements: [{ id: 9, title: 'Welcome' }],
      discussions: [{ id: 5, title: 'Q&A' }],
    });
    expect(profile).toMatchObject({
      name: 'CS101',
      time_zone: 'America/New_York',
      syllabus_excerpt: 'Read chapter 1',
      counts: { assignments: 1, modules: 2, announcements: 1, discussions: 1 },
      module_titles: ['Intro', 'Week 2'],
      announcement_titles: ['Welcome'],
    });
  });
});

describe('buildPlanningSummary', () => {
  const now = '2026-09-07T12:00:00.000Z';
  it('sorts upcoming deadlines and counts undated/past', () => {
    const summary = buildPlanningSummary({
      now,
      assignments: [
        { id: 1, course_id: 1, name: 'Late', due_at: '2026-10-01T00:00:00Z', points_possible: 10 },
        { id: 2, course_id: 1, name: 'Soon', due_at: '2026-09-10T00:00:00Z', points_possible: 5 },
        { id: 3, course_id: 1, name: 'Undated' },
        { id: 4, course_id: 1, name: 'Past', due_at: '2026-01-01T00:00:00Z' },
      ],
    });
    expect(summary.total_assignments).toBe(4);
    expect(summary.total_points).toBe(15);
    expect(summary.undated_assignments).toBe(1);
    expect(summary.past_due).toBe(1);
    expect((summary.upcoming_deadlines as { title: string }[]).map((d) => d.title)).toEqual([
      'Soon',
      'Late',
    ]);
  });
});

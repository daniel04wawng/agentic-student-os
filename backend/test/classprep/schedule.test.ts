import { describe, expect, it } from 'vitest';
import { matchScheduleToCases } from '../../src/classprep/schedule.js';
import type { CaseSegment } from '../../src/materials/split.js';

const cases: CaseSegment[] = [
  { title: 'Life, Death, and Property Rights: AIDS in Africa', text: '' },
  { title: 'Rana Plaza: Workplace Safety in Bangladesh', text: '' },
  { title: 'Cap and Trade in Ontario', text: '' },
  { title: "TransCanada's Keystone XL Pipeline", text: '' },
];

describe('matchScheduleToCases', () => {
  it('maps outline dates to case indices by fuzzy title match', () => {
    const map = matchScheduleToCases(cases, [
      { date: '2026-09-08', caseTitle: 'AIDS in Africa (pharma & IP)' },
      { date: '2026-09-22', caseTitle: 'Rana Plaza Bangladesh' },
      { date: '2026-09-24', caseTitle: 'Cap & Trade Ontario' },
    ]);
    expect(map).toEqual({ '2026-09-08': 0, '2026-09-22': 1, '2026-09-24': 2 });
  });

  it('skips an outline line with no confident case match (falls back to order)', () => {
    const map = matchScheduleToCases(cases, [
      { date: '2026-10-01', caseTitle: 'Guest lecture: careers in ESG' },
    ]);
    expect(map).toEqual({});
  });
});

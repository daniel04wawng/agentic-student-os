import { describe, expect, it } from 'vitest';
import { parseSessionPlans, parseSessionSummary } from '../../src/classprep/ivey-schedule.js';

// Mimics the Ivey "Session Summary" markup: a date, a "Details (Session N)"
// marker, then a "Case:" line (sometimes trailed by study questions), plus a
// file-link artifact that also starts with "Case:" and must be ignored.
const html = `
<div><h3>September 8, 2026</h3><a>Details (Session 1)</a>
  <p>SESSION 1: INTRO</p>
  <p>Prepare: Case: Life, Death, and Property Rights: AIDS in Africa (HBS 702049)</p>
  <p>What are the causes of the central problems?</p></div>
<div><h3>September 10, 2026</h3><a>Details (Session 2)</a>
  <p>Case: &lt;a id="963211" class="instructure_file_link"&gt;taxi.pdf&lt;/a&gt;</p>
  <p>Case: The Taxi Industry in Four Cities Around the World (Ivey AS6801) Looking at the four cities, what is regulated?</p></div>
<div><h3>September 15, 2026</h3><a>Details (Session 3)</a>
  <p>SESSION 3: GLOBALIZATION</p>
  <p>Read: some article</p></div>
`;

describe('parseSessionSummary', () => {
  it('extracts date -> case for published sessions, ignoring file-link artifacts', () => {
    const entries = parseSessionSummary(html);
    expect(entries).toEqual([
      { date: '2026-09-08', caseTitle: 'Life, Death, and Property Rights: AIDS in Africa' },
      { date: '2026-09-10', caseTitle: 'The Taxi Industry in Four Cities Around the World' },
    ]);
    // Session 3 has no assigned case (a theory day) -> skipped.
    expect(entries.some((e) => e.date === '2026-09-15')).toBe(false);
  });
});

describe('parseSessionPlans', () => {
  it('extracts topic, readings, and the professor study questions per session', () => {
    const html = `
<div><h3>September 8, 2026</h3><a>Details (Session 1)</a>
  <p>SESSION 1: WHAT IS THE ROLE OF THE FIRM?</p>
  <p>Read: Emanuel (2019), Big Pharma's Defense, The Atlantic</p>
  <p>Prepare: Case: AIDS in Africa (HBS 702049)</p>
  <p>How should the firms respond to the crisis? What are the costs and benefits?</p></div>`;
    const [plan] = parseSessionPlans(html);
    expect(plan!.topic).toBe('WHAT IS THE ROLE OF THE FIRM?');
    expect(plan!.caseTitle).toBe('AIDS in Africa');
    expect(plan!.readings.some((r) => /Big Pharma/.test(r))).toBe(true);
    expect(plan!.questions).toEqual([
      'How should the firms respond to the crisis?',
      'What are the costs and benefits?',
    ]);
    // The date header ("... Details (Session 1) ...") must NOT be treated as a question.
    expect(plan!.questions.some((q) => /Session|Details/.test(q))).toBe(false);
  });
});

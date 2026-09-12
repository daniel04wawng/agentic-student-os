import { describe, expect, it } from 'vitest';
import { parseSessionSummary } from '../../src/classprep/ivey-schedule.js';

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

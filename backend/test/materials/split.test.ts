import { describe, expect, it } from 'vitest';
import { splitCoursepack } from '../../src/materials/split.js';

/** A prose paragraph long enough to look like real body text. */
const body = (topic: string): string =>
  `This section discusses ${topic} in depth. `.repeat(120);

describe('splitCoursepack', () => {
  it('splits a coursepack into its cases by Ivey product code + title', () => {
    const text = [
      body('an uncoded first case on AIDS in Africa and IP rights'),
      '9B18M132 CAP AND TRADE IN ONTARIO',
      body('the cap and trade policy'),
      '9B16M006 TRANSCANADA KEYSTONE XL PIPELINE',
      body('the pipeline decision'),
      'W34978 CHAMPIONING EDI AND ESG: THE HERSHEY PARADOX',
      body('child labour in cocoa'),
    ].join('\n\n');

    const cases = splitCoursepack(text);
    expect(cases.length).toBe(4);
    expect(cases[0]!.title).toBe('Case 1'); // uncoded lead case
    expect(cases[1]!.title).toContain('CAP AND TRADE');
    expect(cases[2]!.title).toContain('KEYSTONE XL');
    expect(cases[3]!.title).toContain('HERSHEY');
    // Each segment carries its own body, not the whole document.
    expect(cases[1]!.text).toContain('cap and trade policy');
    expect(cases[1]!.text).not.toContain('child labour');
  });

  it('ignores product codes that appear inside prose (no caps title follows)', () => {
    const text = `${body('a single case')} As noted in report 9B18M132, the firm grew. ${body('more analysis')}`;
    expect(splitCoursepack(text)).toEqual([]);
  });

  it('returns [] for a single-case document', () => {
    expect(splitCoursepack(body('one lonely case'))).toEqual([]);
  });

  it('splits by the table of contents, capturing cases with no product code', () => {
    // ToC lists titles with ascending page numbers; bodies print them in a
    // different case and with a curly apostrophe (as the real coursepack does).
    const text = [
      'Ivey Publishing. Table Of Contents',
      'Life, Death, and Property Rights: AIDS in Africa 4',
      "TransCanada's Keystone XL Pipeline 40",
      'Cap and Trade in Ontario 80',
      '9-702-049 REV: NOVEMBER 30 2005', // junk after the ToC
      body('the AIDS in Africa pharmaceutical dilemma'),
      'LIFE, DEATH, AND PROPERTY RIGHTS: AIDS IN AFRICA',
      body('pharma patents and access'),
      'TRANSCANADA’S KEYSTONE XL PIPELINE', // ALL CAPS + curly apostrophe
      body('the pipeline economics'),
      'CAP AND TRADE IN ONTARIO',
      body('the emissions market'),
    ].join('\n');

    const cases = splitCoursepack(text);
    expect(cases.map((c) => c.title)).toEqual([
      'Life, Death, and Property Rights: AIDS in Africa',
      "TransCanada's Keystone XL Pipeline",
      'Cap and Trade in Ontario',
    ]);
    // The Keystone segment is matched despite the ALL-CAPS + curly-apostrophe body.
    expect(cases[1]!.text).toContain('pipeline economics');
    expect(cases[1]!.text).not.toContain('emissions market');
  });
});

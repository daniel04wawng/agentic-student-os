import { describe, expect, it } from 'vitest';
import { FakeModelProvider } from '../../src/model/provider.js';
import { ModelService } from '../../src/model/service.js';
import { generateLectureNotes } from '../../src/lectures/notes.js';

const validNotes = JSON.stringify({
  summary: 'The lecture introduced supply and demand.',
  key_points: ['Demand curves slope down', 'Equilibrium is where supply meets demand'],
  topics: ['microeconomics', 'markets'],
  action_items: ['Read chapter 3 before next class'],
  questions: ['What shifts a demand curve?'],
});

describe('generateLectureNotes', () => {
  it('parses structured notes from the model', async () => {
    const model = new ModelService(new FakeModelProvider(() => validNotes));
    const notes = await generateLectureNotes(model, 'today we cover supply and demand ...', {
      courseName: 'Economics',
    });
    expect(notes.summary).toContain('supply and demand');
    expect(notes.key_points).toHaveLength(2);
    expect(notes.action_items).toEqual(['Read chapter 3 before next class']);
    expect(notes.topics).toContain('markets');
  });

  it('falls back to a deterministic excerpt when the model is unusable', async () => {
    const model = new ModelService(new FakeModelProvider(() => 'not json at all'));
    const transcript = 'A'.repeat(1000);
    const notes = await generateLectureNotes(model, transcript);
    // No fabrication: summary is an excerpt, structured lists stay empty.
    expect(notes.summary.length).toBeGreaterThan(0);
    expect(notes.summary.length).toBeLessThanOrEqual(410);
    expect(notes.key_points).toEqual([]);
    expect(notes.action_items).toEqual([]);
  });
});

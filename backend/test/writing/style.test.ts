import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addWritingSample } from '../../src/writing/profile.js';
import { gatherVoiceGuidance, renderVoice, stripEmDashes } from '../../src/writing/style.js';
import { freshDb, resetDb } from '../db/helpers.js';

describe('stripEmDashes', () => {
  it('replaces em dashes and double hyphens with commas, keeps en dashes', () => {
    expect(stripEmDashes('The plan — bold and clear — worked.')).toBe('The plan, bold and clear, worked.');
    expect(stripEmDashes('cost was low -- profit high')).toBe('cost was low, profit high');
    expect(stripEmDashes('the 1990–2000 period')).toBe('the 1990–2000 period'); // en dash range preserved
  });
});

let db: PGlite;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.close(); });
beforeEach(async () => { await resetDb(db); });

describe('gatherVoiceGuidance / renderVoice', () => {
  it('is empty before any samples, and renders excerpts once samples exist', async () => {
    const empty = await gatherVoiceGuidance(db, { deliverableKind: 'essay' });
    expect(empty.hasSamples).toBe(false);
    expect(renderVoice(empty)).toBe('');

    await addWritingSample(db, {
      source: 'self',
      text: 'I tend to write in short, direct sentences. I avoid filler. I get to the point.',
    });
    const voice = await gatherVoiceGuidance(db, { deliverableKind: 'essay' });
    expect(voice.hasSamples).toBe(true);
    const rendered = renderVoice(voice);
    expect(rendered).toContain('own writing voice');
    expect(rendered).toContain('short, direct sentences');
  });
});

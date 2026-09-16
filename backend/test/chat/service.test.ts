import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { answerQuestion } from '../../src/chat/service.js';
import type { SqlClient } from '../../src/db/client.js';
import { FakeModelProvider, type ModelRequest } from '../../src/model/provider.js';
import { ModelService } from '../../src/model/service.js';
import { freshDb, insertCourse, resetDb } from '../db/helpers.js';

let db: PGlite;
beforeAll(async () => {
  db = await freshDb();
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await resetDb(db);
});

async function insertMaterial(db: PGlite, courseId: string, title: string, text: string): Promise<void> {
  await db.query(
    `INSERT INTO materials (course_id, kind, title, text, source, source_id)
     VALUES ($1,'case',$2,$3,'canvas',$4)`,
    [courseId, title, text, title],
  );
}

describe('answerQuestion', () => {
  it('retrieves matching course material and grounds the model on it', async () => {
    const courseId = await insertCourse(db, 'Marketing');
    await insertMaterial(db, courseId, 'Keystone Pricing Case', 'The Keystone case covers penetration pricing and skimming strategy.');
    await insertMaterial(db, courseId, 'Unrelated Reading', 'A note about supply chain logistics and warehousing.');

    let captured: ModelRequest | undefined;
    const model = new ModelService(
      new FakeModelProvider((req) => {
        captured = req;
        return 'Penetration pricing sets a low entry price [M1].';
      }),
    );

    const res = await answerQuestion(db as unknown as SqlClient, model, { question: 'what is penetration pricing?' });

    // The relevant material is fed to the model and surfaced as a source.
    expect(res.sources.some((s) => s.title === 'Keystone Pricing Case')).toBe(true);
    expect(res.answer).toContain('Penetration pricing');
    const userMsg = captured?.messages.find((m) => m.role === 'user')?.content ?? '';
    expect(userMsg).toContain('Keystone');
  });

  it('still answers (flagging general knowledge) when nothing matches', async () => {
    await insertCourse(db, 'Marketing');
    const model = new ModelService(new FakeModelProvider(() => 'I do not see this in your materials, but generally...'));
    const res = await answerQuestion(db as unknown as SqlClient, model, { question: 'unrelated quantum physics question' });
    expect(res.sources).toHaveLength(0);
    expect(res.answer.length).toBeGreaterThan(0);
  });

  it('returns empty for a blank question without calling the model', async () => {
    const fake = new FakeModelProvider(() => 'should not run');
    const model = new ModelService(fake);
    const res = await answerQuestion(db as unknown as SqlClient, model, { question: '   ' });
    expect(res.answer).toBe('');
    expect(fake.callCount).toBe(0);
  });
});

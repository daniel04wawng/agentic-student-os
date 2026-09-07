import { InngestTestEngine } from '@inngest/test';
import { describe, expect, it } from 'vitest';
import { functions, processWork, routePing } from '../../src/inngest/functions.js';

describe('routePing', () => {
  it('normalizes an incoming ping message', async () => {
    const t = new InngestTestEngine({ function: routePing });
    const { result, error } = await t.execute({
      events: [{ name: 'student/ping', data: { message: 'hi' } }],
    });
    expect(error).toBeUndefined();
    expect(result).toEqual({ message: 'hi' });
  });

  it('defaults the message when absent', async () => {
    const t = new InngestTestEngine({ function: routePing });
    const { result } = await t.execute({ events: [{ name: 'student/ping', data: {} }] });
    expect(result).toEqual({ message: 'ping' });
  });
});

describe('processWork', () => {
  it('completes work on the happy path', async () => {
    const t = new InngestTestEngine({ function: processWork });
    const { result, error } = await t.execute({
      events: [{ name: 'student/work.requested', data: { deliverableId: 'd1' } }],
    });
    expect(error).toBeUndefined();
    expect(result).toEqual({ done: 'd1' });
  });

  it('surfaces a failing step as an error (Inngest retries / onFailure in prod)', async () => {
    const t = new InngestTestEngine({ function: processWork });
    const { result, error } = await t.execute({
      events: [{ name: 'student/work.requested', data: { deliverableId: 'boom' } }],
    });
    expect(result).toBeUndefined();
    expect(error).toBeDefined();
    expect((error as Error).message).toContain('work failed');
  });
});

describe('registration', () => {
  it('exposes all four workflow skeletons', () => {
    expect(functions).toHaveLength(4);
  });
});

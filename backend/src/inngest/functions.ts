import { inngest } from './client.js';

/**
 * Workflow skeletons demonstrating the Inngest foundation: step-level execution
 * (each step is independently retried), function-level retries, scheduled (cron)
 * runs, waiting for a correlated event, and failure-state handling. All events
 * are synthetic for PR 3.
 */

/** Route + normalize an incoming synthetic event. Retried up to 4 times. */
export const routePing = inngest.createFunction(
  { id: 'route-ping', retries: 4, triggers: [{ event: 'student/ping' }] },
  async ({ event, step }) => {
    const normalized = await step.run('normalize', () => ({
      message: event.data.message ?? 'ping',
    }));
    return normalized;
  },
);

/** Scheduled heartbeat (cron) skeleton. */
export const heartbeat = inngest.createFunction(
  { id: 'heartbeat', triggers: [{ cron: '0 * * * *' }] },
  async ({ step }) => {
    return step.run('beat', () => ({ ok: true }));
  },
);

/**
 * Start work, then WAIT for the correlated completion event (matched by
 * deliverableId), with a timeout. Demonstrates durable waits.
 */
export const waitForCompletion = inngest.createFunction(
  { id: 'wait-for-completion', triggers: [{ event: 'student/work.requested' }] },
  async ({ event, step }) => {
    await step.run('start', () => ({ started: event.data.deliverableId }));
    const completed = await step.waitForEvent('await-completion', {
      event: 'student/work.completed',
      timeout: '1h',
      match: 'data.deliverableId',
    });
    return { completed: completed !== null };
  },
);

/**
 * Work that can fail. A failing step triggers Inngest's retries; when they are
 * exhausted, `onFailure` records the failure as an explicit terminal state
 * instead of silently losing the work.
 */
export const processWork = inngest.createFunction(
  {
    id: 'process-work',
    retries: 2,
    triggers: [{ event: 'student/work.requested' }],
    onFailure: async ({ error }) => {
      // In a later PR this records a recoverable failure row; for now it is the
      // explicit failure-state hook.
      return { failed: true, reason: error.message };
    },
  },
  async ({ event, step }) => {
    return step.run('do-work', () => {
      const id = event.data.deliverableId;
      if (id === 'boom') throw new Error('work failed');
      return { done: id };
    });
  },
);

/** All functions, for the serve handler and registration checks. */
export const functions = [routePing, heartbeat, waitForCompletion, processWork];

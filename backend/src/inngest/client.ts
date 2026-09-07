import { Inngest } from 'inngest';

/**
 * Inngest client (durable workflow engine). PR 3 stands up the foundation with
 * SYNTHETIC events only; real domain events are wired in later PRs.
 *
 * Dev mode is auto-detected from INNGEST_DEV; production requires a signing key.
 * The client is safe to import without either (it only needs them to serve).
 * Synthetic event names used by the skeletons:
 *   - student/ping            { message?: string }
 *   - student/work.requested  { deliverableId: string }
 *   - student/work.completed  { deliverableId: string }
 */
export const inngest = new Inngest({ id: 'student-os' });

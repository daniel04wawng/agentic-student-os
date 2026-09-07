import type { FastifyInstance } from 'fastify';
import fastifyInngestPlugin from 'inngest/fastify';
import { inngest } from './client.js';
import { functions } from './functions.js';

/**
 * Mount the Inngest serve endpoint (default path /api/inngest) onto the app.
 * Registration is queued and runs on `ready`; callers gate this on config so an
 * unconfigured backend does not expose the route.
 */
export function registerInngest(app: FastifyInstance): void {
  void app.register(fastifyInngestPlugin, { client: inngest, functions });
}

import { z } from 'zod';

/**
 * Canonical cross-service contracts live here as zod schemas (single source of
 * truth). `scripts/generate-json-schema.ts` emits JSON Schema into `generated/`
 * so the Python service and the SwiftUI app can consume the SAME shapes.
 *
 * PR 0 ships exactly ONE representative contract (health) to prove the
 * approach end-to-end. Domain contracts arrive in their own PRs.
 */

/** HTTP header used to propagate a trace id across service boundaries. */
export const TRACE_HEADER = 'x-trace-id';

export const HealthStatus = z.enum(['ok', 'degraded']);
export type HealthStatus = z.infer<typeof HealthStatus>;

export const HealthResponseSchema = z
  .object({
    status: HealthStatus,
    service: z.string().min(1),
    version: z.string().min(1),
    trace_id: z.string().uuid(),
    uptime_s: z.number().nonnegative(),
  })
  .strict();

export type HealthResponse = z.infer<typeof HealthResponseSchema>;

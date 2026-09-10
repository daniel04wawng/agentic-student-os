import type { SqlClient } from '../db/client.js';
import type { EventBus } from '../events/bus.js';
import type { ModelService } from '../model/service.js';
import { prepareUpcoming } from '../classprep/prep.js';

export interface PrepSchedulerOptions {
  /** How often to check for upcoming classes to prep. Default 30 min. */
  intervalMs?: number;
  /** Prep classes starting within this many hours. Default 48. */
  withinHours?: number;
  now?: () => string;
  /** Observability hook, one call per tick. */
  onTick?: (result: { prepared: number; error?: string }) => void;
}

/**
 * Periodically prepares upcoming classes ahead of time. Runs once on start and
 * then on an interval; a tick never overlaps the previous one, and a failing
 * tick is swallowed (reported via onTick) so the loop keeps running. Returns a
 * stop function.
 *
 * prepareUpcoming is idempotent (it skips sessions that already have a prep), so
 * running frequently is cheap and safe.
 */
export function startPrepScheduler(
  db: SqlClient,
  bus: EventBus,
  model: ModelService,
  opts: PrepSchedulerOptions = {},
): () => void {
  const intervalMs = opts.intervalMs ?? 30 * 60 * 1000;
  const withinHours = opts.withinHours ?? 48;
  const now = opts.now ?? (() => new Date().toISOString());
  let inFlight = false;

  const tick = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    try {
      const prepared = await prepareUpcoming(db, bus, model, {
        now: now(),
        withinHours,
        requireContent: true,
      });
      opts.onTick?.({ prepared });
    } catch (err) {
      opts.onTick?.({ prepared: 0, error: err instanceof Error ? err.message : String(err) });
    } finally {
      inFlight = false;
    }
  };

  void tick();
  const handle = setInterval(() => void tick(), intervalMs);
  if (typeof handle === 'object' && 'unref' in handle) handle.unref();
  return () => clearInterval(handle);
}

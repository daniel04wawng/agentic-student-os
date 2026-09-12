import { existsSync } from 'node:fs';
import { DirectCanvasClient } from './canvas/client.js';
import { prepareUpcoming } from './classprep/prep.js';
import { loadConfig } from './config.js';
import { makeDbClient } from './db/pool.js';
import { EventBus } from './events/bus.js';
import { runLectureTick } from './lectures/process.js';
import { draftPendingDiscussions } from './discussions/service.js';
import { createModelProvider } from './model/factory.js';
import { ModelService } from './model/service.js';
import { registerCanvasProjectors } from './projections/canvas.js';
import { runCanvasSync } from './scheduler/canvas-sync.js';
import { LocalStorageProvider } from './storage/provider.js';
import { createTranscriptionProvider } from './transcription/factory.js';

/**
 * One-shot background tick, run by an external scheduler (e.g. a Modal scheduled
 * function): `node dist/tick.js prep` prepares upcoming classes; `node
 * dist/tick.js sync` refreshes Canvas courses/deadlines/materials. Runs once and
 * exits, so the API can stay a scale-to-zero web endpoint.
 */
function loadDotEnv(): void {
  if (existsSync('.env')) process.loadEnvFile('.env');
}

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();
  if (!config.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const db = makeDbClient(config.DATABASE_URL);
  const bus = new EventBus(db);
  registerCanvasProjectors(bus, db);

  const cmd = process.argv[2];
  if (cmd === 'sync') {
    if (!config.CANVAS_BASE_URL || !config.CANVAS_API_TOKEN) throw new Error('Canvas is not configured');
    const canvas = new DirectCanvasClient({ baseUrl: config.CANVAS_BASE_URL, token: config.CANVAS_API_TOKEN });
    const iveyAuth = { baseUrl: config.CANVAS_BASE_URL.replace(/\/$/, ''), token: config.CANVAS_API_TOKEN };
    console.log('[tick:sync]', JSON.stringify(await runCanvasSync(db, canvas, bus, { iveyAuth })));
  } else if (cmd === 'prep' || cmd === 'regen') {
    const model = new ModelService(createModelProvider(config));
    // `regen` rebuilds preps that already exist (e.g. after a prep-logic change)
    // and reaches further out; `prep` only fills in missing ones for the window.
    const regen = cmd === 'regen';
    const prepared = await prepareUpcoming(db, bus, model, {
      now: new Date().toISOString(),
      withinHours: regen ? 24 * 14 : config.PREP_WITHIN_HOURS,
      requireContent: true,
      includePrepped: regen,
    });
    console.log(`[tick:${cmd}]`, JSON.stringify({ prepared }));
  } else if (cmd === 'drafts') {
    // Draft answers for upcoming discussion assignments (student reviews +
    // submits). Model-heavy, so it runs here rather than on the web endpoint.
    const model = new ModelService(createModelProvider(config));
    const drafted = await draftPendingDiscussions(db, model, {
      now: new Date().toISOString(),
      withinHours: 24 * 7,
    });
    console.log('[tick:drafts]', JSON.stringify({ drafted }));
  } else if (cmd === 'lectures') {
    // Finish any outstanding transcription, then turn completed lecture
    // transcripts into Granola-style notes. Runs to completion here (not on the
    // scale-to-zero web endpoint) so a cold model call is never cut off.
    const storage = new LocalStorageProvider(config.RECORDINGS_DIR);
    const transcription = createTranscriptionProvider(config);
    const model = new ModelService(createModelProvider(config));
    const r = await runLectureTick(db, storage, transcription, bus, model);
    console.log('[tick:lectures]', JSON.stringify(r));
  } else {
    throw new Error(`unknown tick command '${cmd ?? ''}' (use prep|sync)`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });

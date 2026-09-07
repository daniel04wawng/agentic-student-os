import { existsSync } from 'node:fs';
import { loadConfig } from './config.js';
import { buildServer } from './server.js';

/**
 * Load a local `.env` into process.env before reading config, so the documented
 * `cp .env.example .env` workflow actually takes effect (Node does not auto-load
 * `.env`). Best-effort: absence is fine, and real deploys inject env directly.
 */
function loadDotEnv(): void {
  if (existsSync('.env')) {
    process.loadEnvFile('.env');
  }
}

/** Process entrypoint. Fail fast on bad config before opening a socket. */
async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();
  const app = buildServer(config);
  await app.listen({ port: config.BACKEND_PORT, host: config.BACKEND_HOST });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

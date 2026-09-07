import { loadConfig } from './config.js';
import { buildServer } from './server.js';

/** Process entrypoint. Fail fast on bad config before opening a socket. */
async function main(): Promise<void> {
  const config = loadConfig();
  const app = buildServer(config);
  await app.listen({ port: config.BACKEND_PORT, host: '0.0.0.0' });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

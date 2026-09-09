import type { Config } from '../config.js';
import { UnconfiguredGoogleDocsClient, type GoogleDocsClient } from './client.js';
import { ComposioClient, ComposioGoogleDocsClient } from './composio.js';

/**
 * Build the Google Docs client. Uses the Composio-backed client when
 * COMPOSIO_API_KEY is set, otherwise an Unconfigured client that fails loudly if
 * called, so the rest of the app can construct without Google credentials.
 */
export function createGoogleDocsClient(config: Config): GoogleDocsClient {
  if (config.COMPOSIO_API_KEY) {
    return new ComposioGoogleDocsClient(
      new ComposioClient(config.COMPOSIO_API_KEY, config.COMPOSIO_USER_ID),
    );
  }
  return new UnconfiguredGoogleDocsClient();
}

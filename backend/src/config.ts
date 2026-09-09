import { z } from 'zod';

/**
 * Environment config for the backend. Validated once at startup so a
 * missing/malformed var fails fast with a clear message instead of surfacing
 * as an undefined deep in a handler.
 *
 * PR 0 keeps this to runtime basics only. Provider/DB vars are declared in
 * `.env.example` but intentionally NOT required here until their PR wires them.
 */
const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  BACKEND_PORT: z.coerce.number().int().positive().max(65535).default(3000),
  // Loopback by default so the dev server is not exposed on the LAN. Deploy
  // targets that must bind all interfaces set BACKEND_HOST=0.0.0.0 explicitly.
  BACKEND_HOST: z.string().min(1).default('127.0.0.1'),
  // Inngest: the serve endpoint is mounted only when dev mode or a signing key
  // is present, so the default backend has no unconfigured /api/inngest route.
  INNGEST_DEV: z.preprocess((v) => v === '1' || v === 'true', z.boolean()),
  INNGEST_SIGNING_KEY: z.string().min(1).optional(),
  // Canvas (read-only ingestion). Both required to construct a live client.
  CANVAS_BASE_URL: z.string().url().optional(),
  CANVAS_API_TOKEN: z.string().min(1).optional(),
  // Postgres/Supabase connection. When present, the backend mounts the
  // DB-backed read/notification routes.
  DATABASE_URL: z.string().min(1).optional(),
  // Local directory for audio blobs (dev). Production should use S3/Supabase
  // Storage with presigned uploads instead.
  RECORDINGS_DIR: z.string().min(1).default('./data/recordings'),
  // Model provider selection. 'fake' is a deterministic stub; 'ollama' is the
  // local on-device path; 'modal' is the hosted heavy-model path.
  MODEL_PROVIDER: z.enum(['fake', 'ollama', 'modal']).default('fake'),
  OLLAMA_URL: z.string().url().default('http://localhost:11434'),
  MODEL_NAME: z.string().min(1).default('gemma2'),
  MODAL_MODEL_URL: z.string().url().optional(),
  MODAL_MODEL_TOKEN: z.string().min(1).optional(),
  // Deepgram speech-to-text. A plain API key (not OAuth); when present the real
  // provider is used, otherwise a deterministic fake. Audio goes straight to
  // Deepgram, so this is not brokered through any integration platform.
  DEEPGRAM_API_KEY: z.string().min(1).optional(),
  // Composio brokers Google (Docs/Drive/Calendar) + Gmail via OAuth. When the
  // key is present, the real Google client is used; actions run as the connected
  // account for COMPOSIO_USER_ID.
  COMPOSIO_API_KEY: z.string().min(1).optional(),
  COMPOSIO_USER_ID: z.string().min(1).default('default'),
  // Gate for autonomous Canvas submission. Off by default (submit only on
  // explicit user action / approval).
  AUTO_SUBMIT: z.preprocess((v) => v === '1' || v === 'true', z.boolean()),
});

export type Config = z.infer<typeof ConfigSchema>;

/**
 * Parse config from an env-like record (defaults to `process.env`).
 * Throws a readable aggregated error when validation fails.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid backend configuration:\n${details}`);
  }
  return parsed.data;
}

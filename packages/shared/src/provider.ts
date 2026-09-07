/**
 * Provider / provenance source vocabulary. Shared because both the event
 * envelope (source of an event) and the DB layer (row provenance) reference it.
 * The DB `provider` enum in migration 0001 must match this list; a backend
 * drift test enforces that.
 */
export const PROVIDERS = ['canvas', 'google', 'outlook', 'deepgram', 'manual', 'system'] as const;
export type Provider = (typeof PROVIDERS)[number];

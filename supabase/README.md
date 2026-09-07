# Database (Supabase / Postgres)

The **SQL migrations in `migrations/` are the single source of truth** for the
Student World State schema. `backend/src/db/schema.ts` mirrors the enums/table
names for typed application code and is kept honest by a drift test.

## Apply migrations
- **Remote (Supabase):** `supabase link --project-ref <ref>` then `supabase db push`.
- **Local (needs Docker):** `supabase start` applies `migrations/` automatically.

## Tests (no Docker)
Backend tests apply these exact migrations to an embedded **PGlite** instance
(real Postgres in WASM), so DDL is validated without a database service:
`cd backend && npm test`.

## Conventions
- Files: `NNNN_name.sql`, applied in lexical order.
- Every externally-sourced row carries provenance (`source`, `source_id`,
  `source_url`, `ingested_at`) and a partial unique index on `(source, source_id)`.
- Timestamps are `timestamptz`. Deadlines keep `due_source_timezone` separately
  from the absolute instant (the reconciliation engine is PR 6).
- Migrations are additive and forward-only; never edit a migration that has been
  applied to a shared environment. Add a new file instead.

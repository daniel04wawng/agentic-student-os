# Manual test log (per PR)

What to verify for each shipped PR when you have time. Automated tests + CI
already gate every merge; this log is for the things a human should sanity-check
after deploy, plus anything that needs real credentials/services that CI can't
exercise.

Legend: [auto] covered by automated tests/CI · [manual] do this yourself after deploy · [needs-creds] blocked until a real provider key/account exists.

---

## PR 0 — Repository foundation
- [auto] Both services build; `/health` returns `{status,service,version,trace_id,uptime_s}`; CI green (TS/Python/iOS).
- [manual] Backend `/health`: response `x-trace-id` header equals body `trace_id`; send your own valid uuid header -> echoed back; send garbage -> replaced; two calls get different ids.
- [manual] Set `BACKEND_PORT` / `BACKEND_HOST` in `backend/.env` -> server actually uses them (proves .env loading).
- [manual] Inference `/health` same checks; `/openapi.json` returns 200.
- [manual] iOS app launches; "Check backend health" shows "backend: ok" when backend reachable (ATS allows local networking; only localhost/LAN is exempt for http).

## PR 1 — Core world state (schema only, no UI)
- [auto] Migration `0001` applies on fresh Postgres; enum rejection, `(source,source_id)` dedup, deliverable one-parent CHECK, updated_at trigger, ownership cascade, enum drift guard.
- [needs-creds] When a Supabase project exists: `supabase link --project-ref <ref> && supabase db push` applies `0001` cleanly to real Postgres.
- [manual] After push, in the Supabase SQL editor: inserting a duplicate `(source,source_id)` course fails; a deliverable with both/no parent fails; deleting a course cascades to its assignments/deliverables/artifacts; a person survives course deletion with `course_id` nulled.

## PR 2 — Event bus + idempotency (no UI; internal)
- [auto] Migration `0002` adds `idempotency_key` (unique), `trace_id`, `processed_at` to `events`. Bus tests: new event recorded + handler runs once + `processed_at` stamped; duplicate delivery (same key) records once and dispatches once; malformed envelope rejected with no write; unknown event name still recorded; dispatch runs inside the event's trace scope; payload round-trips as jsonb; a failing handler leaves `processed_at` NULL and re-delivery still dedups.
- [manual] After deploy, publish the same event twice (same `idempotency_key`) -> only one `events` row, one side effect. Confirm `events.trace_id` is set and matches the producing request's trace id.
- Known gap to watch: insert/dispatch/stamp are separate autocommits, so a crash between a successful dispatch and the `processed_at` stamp leaves the row "unprocessed" though handlers ran (safe only because handlers are idempotent). Robust retry/processing is PR 3.

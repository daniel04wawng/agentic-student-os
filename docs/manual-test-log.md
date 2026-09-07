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

## PR 3 — Inngest foundation (synthetic events, no UI)
- [auto] Function skeletons unit-tested offline via @inngest/test: `routePing` normalizes + defaults; `processWork` completes happy path and surfaces a failing step as an error (Inngest retries + `onFailure` in prod). Serve endpoint is gated: default backend returns 404 at `/api/inngest`; with `INNGEST_DEV=1` the route is mounted.
- [needs-creds] Live orchestration (retries actually re-running, `waitForCompletion` durable wait, `heartbeat` cron, `onFailure` after exhausted retries) can only be exercised against the Inngest dev server / cloud. To test locally: `npx inngest-cli@latest dev`, run backend with `INNGEST_DEV=1`, POST `student/ping` and `student/work.requested` events, and watch the Inngest dashboard for runs/retries/waits.
- [manual] With dev server running: send `student/work.requested {deliverableId:"x"}` then `student/work.completed {deliverableId:"x"}` -> `waitForCompletion` resolves `{completed:true}`; send only the request and wait past timeout -> `{completed:false}`. Send `deliverableId:"boom"` -> `processWork` retries twice then `onFailure` fires.
- Known limitation: events are untyped (`event.data` is loose) because this inngest build doesn't export `EventSchemas`; typed event schemas come later.

## PR 4 — Canvas auth + read-only ingestion (no UI; READ ONLY)
- [auto] `DirectCanvasClient` (mock fetch): sends `Bearer` token + Accept header; follows Link-header pagination; throws `CanvasError` with status on non-2xx; `diagnose()` reports ok/not-ok. Normalizers produce valid event envelopes with `source=canvas` and a stable idempotency key (independent of ingestion time). `ingestCanvas` publishes course+assignment events; re-running creates ZERO duplicates (dedup by idempotency key).
- [needs-creds] Live Canvas: set `CANVAS_BASE_URL` + `CANVAS_API_TOKEN` (a personal access token from Canvas > Account > Settings > New Access Token). Then run a diagnose call -> should return your user; run ingestion -> `events` table fills with `canvas.course.discovered` / `canvas.assignment.discovered` rows, one per object, none duplicated on a second run.
- [manual] Confirm the client NEVER writes to Canvas (no submit/POST methods exist) and the token appears only in the Authorization header, never in URLs or logs.
- Decision still open (does not block): Composio-managed Canvas connection vs the direct-token path. Direct is implemented; Composio is stubbed behind the same `CanvasClient` interface (factory throws "not configured"). Tell me which you want for production.
- Known limitation: a Canvas HTTP error aborts the ingestion run (loud failure); wrapping ingestion in an Inngest workflow for retries/partial-progress is a later integration.

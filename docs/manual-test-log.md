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

## PR 5a — Canvas event projectors (events -> canonical tables; no UI)
- [auto] `upsertCourseFromEvent` / `upsertAssignmentFromEvent` project discovery events into `courses` / `assignments`: insert once, update canonical fields (name/due/points) on re-projection, and PRESERVE our lifecycle `status` (a re-projection never resets an assignment from review_ready back to not_started). Metadata merge drops nulls so a later event never wipes stored fields (e.g. time_zone). Assignment projection resolves the course by `(source,source_id)` and throws if the course is not yet projected. End-to-end `ingestCanvas` + registered projectors populates both tables.
- [needs-creds] With a real Canvas token: run ingestion, then confirm `courses` and `assignments` tables are populated (one row per Canvas object) and the course's IANA time zone is captured in `courses.metadata.time_zone`.
- [manual] Set an assignment's `status` in the DB, re-run ingestion, and confirm the status is NOT reset (only canonical fields update).
- Architecture note: Canvas CHANGES (e.g. a due date edited in Canvas) are not yet propagated, because discovery events are deduped by identity. Change propagation is reconciliation (PR 26) via update-type events with content-based idempotency keys.

## PR 5b — Course onboarding (migration 0003; no UI)
- [auto] `onboardCourse` ingests a course + its assignments (via projectors), reads syllabus/modules/announcements/discussions best-effort, and writes a derived `course_profiles` row (profile + deterministic planning summary). Idempotent re-run keeps one course/profile and refreshes it. Best-effort: if modules/announcements are inaccessible (403), onboarding still succeeds with empty counts. Profile/summary builders are pure (no LLM): counts, module/announcement titles, syllabus excerpt (HTML stripped), and upcoming deadlines sorted with undated/past-due counts.
- [needs-creds] With a real Canvas token: onboard a course id and confirm `courses`/`assignments` fill, a `course_profiles` row appears with a sensible syllabus excerpt + upcoming-deadline list, and re-onboarding updates `generated_at` without duplicating anything.
- [manual] Confirm the profile is stored in `course_profiles` (derived), NOT written onto the canonical `courses` row.
- Note: onboarding is deterministic aggregation only; it does NOT start any assignment work (that's PR 20). Richer LLM synthesis can layer on once the model layer (PR 12) exists.

## PR 6 — Deadline / timezone engine (pure + reconciliation; no UI)
- [auto] DST correctness: same wall intent shows -04:00 (EDT) in summer vs -05:00 (EST) in winter for America/New_York. "11:59pm ET" stored as next-day UTC renders back to `2026-04-30 23:59`. Travel: one instant shows different wall clocks in NY vs Tokyo. `resolveDeadline` picks explicit source tz, else course fallback, else unknown, and flags source/course mismatch. Conservative conflict finder flags deadlines within a window. Reconciliation fills a missing `due_source_timezone` from the course tz, records `metadata.tz_resolution`, and is idempotent.
- [manual] On device: change the iPhone's timezone (Settings) or travel; a deadline should keep the same absolute time but display both the course (source) timezone and your current timezone, and never silently shift. Cross a DST boundary and confirm the displayed offset changes but the instant does not.
- [manual] An assignment whose Canvas tz is missing should, after reconciliation, show the course's timezone with `tz_resolution: course_fallback`; one with no course tz stays "unknown" (shown conservatively).

## PR 7a — Notification persistence + failure-safe dispatch (migration 0004; no UI)
- [auto] `registerDevice` idempotent on token; `createNotification` dedups on `dedup_key`; `dispatchPending` marks delivered on success, and on push failure marks the item `failed` (attempts++, last_error) but PRESERVES it (never lost), with no device it stays `pending`, and a later dispatch retries a failed item. `dismissNotification` sets dismissed.
- [needs-creds] Real push delivery needs an APNs auth key (and later a real sender implementing `PushSender`); the default `NoopPushSender` "succeeds" without sending. Until then, verify the invariant matters: the in-app notification row is the source of truth and survives any delivery failure.
- [manual] Kill the push path (or use the failing sender) and confirm the review/deadline item still appears in the app's lists (PR 7b/7c) — delivery failure must not remove it.

## PR 7b — Today/Review/Deadlines read views + HTTP routes (no UI yet)
- [auto] `getDeadlines` returns dated assignments within a horizon, each resolved into source + current timezone, sorted; `getReview` returns review_ready notifications + assignments; `getToday` returns today's (current-tz) deadlines + active notifications. Routes: `POST /devices` (400 on bad body), `GET /deadlines?tz=&horizon=`, `GET /today?tz=`, `GET /review`, `POST /notifications/:id/dismiss` (400 on non-uuid). Routes are mounted ONLY when a DB client is injected (404 otherwise).
- [needs-creds] Set `DATABASE_URL` (Supabase) so the backend mounts these routes against real Postgres. Then: `curl localhost:3000/deadlines?tz=America/New_York`, `/today`, `/review`; `POST /devices {token}`.
- [manual] Confirm `/deadlines` shows each deadline in BOTH the course (source) timezone and the tz you pass, and dismissing a notification removes it from `/today` and `/review` but the row still exists (status=dismissed), not deleted.

## PR 7c — iOS shell: Today / Review / Deadlines + push registration
- [auto] The iOS app now builds in CI (full simulator build added to the ios job, not just project-parse). App shows a TabView: Today, Review, Deadlines, Status. `DeadlineRow` renders each deadline in both the source timezone and the device timezone. `AppDelegate` requests notification authorization and registers for remote notifications, forwarding the APNs token to `POST /devices`.
- [needs-creds] Real push delivery needs: the Push Notifications capability + an `aps-environment` entitlement + an APNs auth key on the backend sender. Until then, `registerForRemoteNotifications` will call `didFailToRegister` (handled) in the simulator; the app still works fully.
- [manual] Run the app pointed at a backend with `DATABASE_URL` set + some seeded courses/assignments: Today/Deadlines populate, each deadline shows source vs your-current time, pull-to-refresh works, and turning the backend off shows a friendly "Couldn't load" state (no crash). Change your device timezone and confirm the "Your time" line updates while the source time stays put.

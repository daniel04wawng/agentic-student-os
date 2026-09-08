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

## PR 8a — Backend recordings + storage abstraction + upload endpoint (migration 0005)
- [auto] `registerRecording` idempotent on a client-generated id; `storeAudio` writes to a `StorageProvider` then marks the row `stored` (byte_size/storage_key/uploaded_at), is idempotent (resumable retry), and on a storage failure marks the row `failed` but NEVER loses it (device keeps its local copy). Routes: `POST /recordings` (register -> upload_path), `PUT /recordings/:id/audio` (raw bytes -> stored; 400 empty, 404 unknown). StorageProvider impls: InMemory (tests), Local FS (dev).
- [needs-creds] Production storage should be S3 / Supabase Storage with PRESIGNED uploads (client uploads directly, not through the backend); the `StorageProvider` interface is the swap point. Local FS is dev-only (Railway's disk is ephemeral). Set `RECORDINGS_DIR` for the local path.
- [manual] With `DATABASE_URL` set: `POST /recordings {client_id}` returns an id + upload_path; `PUT` audio bytes to it returns `{status:stored}`; re-`PUT` (resume) still succeeds; posting the same client_id twice returns the same id.

## PR 8b — iOS recorder + durable audio + resumable upload queue
- [auto] Ran on the simulator (xcodebuild test): recorder state machine transitions; `RecordingStore` persists across reload (offline durability); `RecordingUploader.uploadPending` marks uploaded on success, and on failure KEEPS the item + local file and retries successfully (resumable). CI now `build-for-testing` (compiles the test target too).
- [manual] On a real device (mic needed): tap Record -> Stop; a recording appears with duration and `pending`; tap "Upload pending" against a running backend -> it flips to `uploaded`. Kill the network mid-upload -> it shows `failed`, the audio file is retained, and a later "Upload pending" succeeds. Force-quit the app mid-recording and reopen -> the partial file is still on disk (AVAudioRecorder writes as it records).
- Known limitation: uploads go through the app foreground via `URLSession.data`; true background/resumable transfer (URLSession background tasks + presigned S3) is a later hardening. Mic permission prompt uses `NSMicrophoneUsageDescription`.

## PR 9 — Deepgram transcription (migration 0006; credential-gated)
- [auto] `requestTranscription` idempotent per recording; `runTranscription` fetches stored audio, calls the provider, stores diarized words (timestamps + speaker) + utterances, and emits `transcription.completed`. On provider failure it marks the transcript `failed` (attempts++) and LEAVES THE AUDIO untouched (recording stays `stored`, no completion event) — retry succeeds later. `DeepgramProvider.parse` maps transcript/words/utterances/language/duration; `.transcribe` sends `Token` auth and throws on non-2xx.
- [needs-creds] Set `DEEPGRAM_API_KEY` and use `DeepgramProvider` instead of the fake. Then transcribe a real recording and confirm word timestamps + speaker labels look right.
- [manual] Simulate Deepgram being down (bad key / offline) and confirm: the transcript row is `failed`, the audio file is still present and the recording is still `stored` (nothing lost), and re-running transcription completes it and fires `transcription.completed` exactly once.
- Note: this PR is the transcription service + provider; wiring it to auto-run after upload via an Inngest workflow (with retries) is a later integration (PR 10+).

## PR 10 — Transcript processing + session resolution (no UI)
- [auto] `extractStructure` (deterministic, no LLM) computes word/utterance/speaker counts. `resolveSession` matches a recording's capture time to a UNIQUE scheduled session window (else stays unresolved: no_timestamp / no_match / ambiguous — never guessed). `processTranscript` stores the extraction in `transcripts.metadata.extraction`, links `recordings.session_id` (with provenance) or records the unresolved reason, and emits `transcript.processed`. `registerTranscriptProcessor` auto-runs it when `transcription.completed` fires.
- [manual] After transcribing a recording captured during a class session, confirm the recording gets `session_id` set and `metadata.session_resolution = schedule_time_match`; a recording with no matching session keeps `session_id` null with `session_resolution = no_match` (still processed, not dropped). Overlapping sessions -> `ambiguous` (left for later disambiguation).
- Note: structured extraction is counts-only for now; semantic extraction (topics, action items) waits for the model layer (PR 12).

## PR 11a — Retrieval: chunking + full-text search (migration 0007; no UI)
- [auto] `chunkUtterances` groups diarized utterances under a char budget while preserving span timestamps (`chunkText` fallback for raw text). `indexTranscript` writes chunks with course/session context and is idempotent (re-index replaces). `fullTextSearch` uses a generated `tsvector` + `ts_rank` to return only the relevant chunks (not whole transcripts), scoped optionally by course.
- [manual] After indexing a lecture transcript, search a keyword from it -> the matching chunk comes back ranked; an unrelated keyword returns nothing; the course filter excludes other courses' chunks. (Confirms "retrieve relevant context without loading entire transcripts".)

## PR 11b — Embeddings + semantic search (migration 0008; no UI)
- [auto] `Embedder` abstraction + deterministic `FakeEmbedder` (bag-of-words); `cosineSimilarity`; `embedTranscriptChunks` embeds only unembedded chunks (idempotent, no re-embedding unchanged text = cost control); `semanticSearch` embeds the query and ranks chunks by cosine, scoped by course. Semantic ranking verified (closest chunk first).
- [needs-creds] The real embedder = Gemma via the inference service (PR 12). Swap `FakeEmbedder` for it; no interface change.
- Engineering note: embeddings are stored as a float array (jsonb) for portability/testability. PRODUCTION SCALING: switch the column to pgvector `vector(<dim>)` + an HNSW index and change only the ranking SQL — the embed/search interface is unchanged. (PGlite 0.5.x doesn't bundle pgvector, which is why the test path uses app-side cosine.)

## PR 11c — Hierarchical summaries (migration 0009; no UI)
- [auto] `summaries` table with scope section/session/course + a `key` for idempotent upsert. `buildTranscriptSummaries` writes a section summary per chunk + one session/lecture summary; `buildCourseSummary` rolls session summaries up into a course summary. Deterministic (truncation/roll-up), idempotent re-runs.
- [needs-creds] Real LLM summaries (Gemma, PR 12) replace the truncated text later — same table, `metadata.method` records provenance.
- [manual] After summarizing a couple of lectures in a course, confirm the course summary mentions content from each lecture, and re-running doesn't duplicate rows.

## PR 12 — Model (Gemma) abstraction (no UI)
- [auto] `ModelProvider` interface over local (Ollama) + Modal + a deterministic `FakeModelProvider`. `ModelService` adds: caching (`hashRequest` -> identical inputs skip the provider), structured-output validation against a zod schema with retries + a DETERMINISTIC FALLBACK (used when the model is unavailable or keeps returning invalid output), and inference tracing (`onTrace` with trace_id/latency/cache-hit). `extractJson` handles ```json fences + prose. Ollama/Modal providers parse responses and raise `ModelUnavailableError` on failure/misconfig.
- [needs-creds/setup] **This is the model boundary.** Real inference needs one of: (a) Ollama running locally with a pulled model — you have Ollama installed; run `ollama pull gemma2` and set `MODEL_PROVIDER=ollama`; or (b) a Modal-hosted endpoint — set `MODAL_MODEL_URL` + `MODAL_MODEL_TOKEN` and `MODEL_PROVIDER=modal`. Until then the default `fake` provider returns stubs.
- [manual] With Ollama + gemma2: point `MODEL_PROVIDER=ollama`, ask for a structured JSON (e.g. an assignment plan) and confirm it validates; kill Ollama and confirm the deterministic fallback kicks in rather than crashing; repeat an identical request and confirm the cache serves it (no second inference).

## PR 13 — FunctionGemma local tool router (no UI)
- [auto] `ToolRegistry` with permission tiers (local_read / local_write / remote_side_effect). `FunctionRouter` asks the local model for a `{name, arguments}` call, then DETERMINISTICALLY enforces: tool must exist, be within the allowed permission set (local_read only), and args must satisfy the tool's zod schema. A side-effect tool is DENIED without executing; bad args/unknown tool/unusable model output all decline safely.
- [backfill: model] Real routing quality needs a local model (Ollama+gemma2). Logic + permission enforcement are fully tested with the fake model.

## PR 14 — Main Student planner (no UI)
- [auto] `gatherWorldState` (deterministic) reads active assignments. `generatePlan` asks the model for a structured plan (capability steps) and falls back to a DETERMINISTIC rule-based plan when the model is unusable (context_ready -> generate, upcoming not_started -> plan). `runPlan` emits `student.plan` + one `capability.requested` per step (capabilities executed by later PRs).
- [backfill: model] Plan quality needs a real model; structure + deterministic fallback + event emission are fully tested with the fake.

## PR 15 — Dynamic readiness contracts (migration 0010; no UI)
- [auto] Deterministic. `createContract`/`reviseContract` store requirements (blocking vs optional). `evaluate` -> ready only when every blocking requirement is resolved; on first ready it promotes the assignment to `context_ready` (from pre-ready states only) and emits `assignment.context_ready` exactly once. `resolveByEvidence(key)` resolves matching requirements and re-evaluates only affected assignments; an unmatched key changes nothing. New evidence can ADD a blocking dependency (revision) that reverts readiness.
- [manual] Assignment needing a future lecture stays pending until that lecture's evidence arrives, then fires context_ready once; an assignment with only optional context is ready immediately; an unrelated lecture doesn't trigger readiness.
- No model needed (fully deterministic per the "don't run an LLM where deterministic logic works" invariant).

## PR 16 — Class prep (migration 0011; no UI)
- [auto] `detectUpcomingClasses` finds sessions in a time window lacking a prep. `gatherPrepContext` (deterministic) pulls prior session summaries + readings. `prepareClass` synthesizes a prep (model + deterministic fallback), upserts one prep per session, creates a pre-class notification (deduped per session), and emits `class.prep.ready` once. Idempotent.
- [backfill: model] Rich prep synthesis needs a real model; structure/context-gathering/notification/event are tested with the fake (deterministic fallback).
- [manual] Before an upcoming class, confirm a prep artifact + a "Class prep ready" notification appear; re-running doesn't duplicate them.

## PR 17 — Google artifact layer + remote-version tracking (no UI)
- [auto] `GoogleDocsClient` abstraction (create/update/getRevision) with a `FakeGoogleDocsClient` (monotonic revisions). `createGoogleDocArtifact` creates a doc and registers an artifact capturing its URI, remote doc id (source_id), and remote revision (remote_version). `updateArtifactRemoteVersion` records new revisions. `UnconfiguredGoogleDocsClient` fails clearly until OAuth is connected.
- [backfill: Google account] The real client needs a connected Google account (OAuth via Composio or the Google API). Once connected, creating an artifact should produce a real Doc and store its revision id.
- Decision (does not block): Composio-managed Google OAuth vs direct Google API. Interface is identical; tell me which for production.

## PR 18 — User-edit conflict handling (CRITICAL; no UI)
- [auto] `safeAgentEdit` runs the agent's edit against the CURRENT remote content, so out-of-band user changes are always the base (user-wins). It detects when the remote revision moved since our last known revision, flags/records a rebase, advances `remote_version`, and — proven by an explicit overwrite-prevention test — NEVER discards the user's text (the agent change is additive/merged, not a replacement).
- [backfill: Google account] The real diff/rebase runs against actual Google Docs revisions once OAuth is connected; logic is fully tested against the fake client.
- [manual] Edit an agent-created Doc yourself, then trigger an agent edit; confirm your text is preserved and the change is merged, never overwritten; the artifact's `remote_version` advances and `metadata.last_rebased` is true.

## PR 19 — Contextual writing retrieval (migration 0012; no UI)
- [auto] Deterministic style features (avg sentence length, type-token ratio, formality). `addWritingSample` stores samples with course/professor/deliverable-kind scoping + a weight. `buildStyleProfile` computes a weighted-average style profile, weighting closer contextual matches more (course 2x, kind/professor 1.5x). `recordEditSignal` stores the user's edited text as a LOW-weight (0.2) 'self' sample; a lone edit only nudges the profile (proven bounded), so there's no global over-learning from one edit.
- [manual] Confirm the style profile for a course leans toward that course's/professor's samples, and that editing one draft doesn't swing the whole profile.

## PR 20 — Assignment generation (no UI; NO Canvas submit)
- [auto] Pipeline: draft (model + deterministic fallback) -> create Google Doc artifact -> critique -> revise (rebase-safe via safeAgentEdit) -> deterministic QA -> REVIEW_READY. INVARIANT enforced + tested: `transitionToReviewReady` throws unless a real artifact exists for the assignment (an assignment can never reach review_ready without an artifact). Emits `assignment.review_ready`. No Canvas submission.
- [backfill: model + Google] Draft/critique/revise quality needs a real model; live Docs need Google OAuth. The full pipeline + QA gate + invariant + state transitions are tested with fakes/deterministic fallbacks.
- [manual] Trigger generation for a context_ready assignment; confirm a Doc is created, the assignment reaches review_ready only with an artifact, and the artifact is marked review_ready.

## PR 21 — Review packets (migration 0013; no UI yet)
- [auto] `buildReviewPacket` (deterministic) assembles a concise summary, main argument (first sentence), warnings (short_draft / no_source_citation), a reading-time review estimate, the artifact link + version, and source links from a REVIEW_READY artifact; idempotent per (assignment, artifact version); throws when there is no review_ready artifact. `GET /assignments/:id/review-packet` returns the stored packet (404 if none).
- [manual] After an assignment reaches review_ready, fetch its review packet and confirm it shows a summary, main argument, warnings, an estimate, and the Doc link + version. (The iOS approval UI lands with PR 22 versioned approval.)

## PR 22 — Versioned approval (migration 0014; CRITICAL)
- [auto] `approveArtifact` records an approval tied to the artifact's exact remote_version. ANY post-approval modification (safeAgentEdit advances the version) invalidates the approval automatically (proven), retaining the invalidated row as an audit trail with reason `post_approval_modification`. `isApproved` is true only when an active approval matches the current version. Re-approval after a change is valid again. `getPermissionPolicy` defaults to `require_review`. Routes: `POST /artifacts/:id/approve`, `GET /artifacts/:id/approval`.
- [manual] Approve a draft, then let the agent (or yourself) edit it -> the approval flips to invalid; the approvals table keeps the old approval as an audit record; re-approving the new version restores validity.
- Note: the iOS approve button wires to POST /artifacts/:id/approve (UI polish can follow).

## PR 23 — Canvas submission (migration 0015; EXTRA CARE)
- [auto] `submitAssignment` enforces every invariant: REFUSES to submit under require_review without an exact-version approval (Canvas is never called); submits the approved artifact; VERIFIES by reading the submission back from Canvas and only then marks `verified` (a successful write call alone is not success); a verification failure yields `failed` (assignment NOT marked submitted); idempotent (a verified submission is never re-sent - submitCount stays 1); `auto` policy permits submission without approval. Emits `assignment.submitted`. `AUTO_SUBMIT` flag (off by default) gates autonomous submission.
- [backfill: Canvas write token] Real submission needs a Canvas token with submission scope + a `CanvasSubmitClient` implementation; the fake proves the state machine + invariants.
- [manual] Try to submit an unapproved assignment -> refused; approve then submit -> verified only after read-back; submit again -> no double submission; simulate a verification failure -> marked failed, not submitted.

## PR 24 — Outlook + admin (no UI)
- [auto] `OutlookClient` abstraction (+ fake / unconfigured). Deterministic `classifyMessage` (scheduling/payment/form/email). `ingestOutlook` turns messages + calendar events into `admin_items` with classification, idempotent by (source, source_id). `draftReply` uses the model with a deterministic template fallback; drafting ONLY (sending is an approval-gated side effect).
- [backfill: Microsoft account] Live email/calendar needs managed OAuth (Composio or Graph API). Classification/extraction/idempotency/drafting are tested against the fake.
- [manual] After connecting Outlook, ingest -> admin items appear classified; re-ingest doesn't duplicate; a draft reply is generated but NOT sent without approval.

## PR 25 — Manual chat control plane (migration 0016; no UI)
- [auto] `parseCommand` (deterministic) parses pause/resume/defer-until/set-policy with global or course scope; switching policy to `auto` is flagged dangerous. `applyCommand` persists control state, scopes pause to a single course (course A paused doesn't pause B), and REFUSES a dangerous override without `confirmed:true` (needs_confirmation, no mutation) — applying only on confirmation. `isPaused` reflects course OR global pause.
- [backfill: model (optional)] Deterministic keyword parsing covers the safety-critical commands; a model can enrich free-form NL later without changing the safe core.
- [manual] "pause course X" / "resume" toggle proactive work for that scope; "set policy to auto" asks for confirmation before removing the review gate.

## PR 26 — Reconciliation + recovery hardening (migration 0017; no UI)
- [auto] Retry queue: enqueue -> claim due -> failRetry with backoff -> `dead` after max attempts (surfaced, not lost). `reconcileArtifacts` detects out-of-band Google edits (stored vs live revision), records drift, and invalidates stale approvals. `detectStaleState` finds items stuck in transient states (uploading/processing/submitting) past a threshold. `recoverySnapshot` summarizes failed/dead work across recordings/transcripts/submissions/notifications/retries.
- [backfill: providers] Canvas/Outlook live reconciliation runs against real providers once connected; the artifact-drift path, retry queue, stale detection, and snapshot are fully tested.
- [manual] Edit an artifact out of band -> reconciliation flags drift + invalidates approval; a stuck submission shows up in stale detection; the recovery snapshot counts failures.

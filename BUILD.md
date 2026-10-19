# How this was built (and how to copy it)

Student OS is a study assistant for a specific course. You ask it questions in plain
language and it answers from your actual course material (the primers, the readings,
the per-session schedule) with citations you can click. It also has a built-in
readable "textbook" of the course primers and basic traffic stats.

This doc explains the architecture and gives a step-by-step to stand up your own copy.

---

## The stack

Everything is one monorepo. The pieces run in three places.

| Piece | Tech | Runs on |
| --- | --- | --- |
| Web app | Next.js (App Router), standalone output | Railway |
| Backend API + background jobs | TypeScript, Fastify | Modal (scale-to-zero) |
| Database | Postgres | Supabase |
| Embeddings (semantic search) | `bge-small-en-v1.5` (sentence-transformers) | Modal (CPU, kept warm) |
| Chat model | Gemma 4 26B, OpenAI-compatible, multimodal | Modal LLM endpoint |
| iOS app (optional) | SwiftUI | Xcode / TestFlight |

Repo layout:

```
backend/     TypeScript backend (Fastify). API routes, Canvas sync, retrieval, chat.
web/         Next.js web app (the thing users open). Standalone, NOT an npm workspace.
packages/    Shared zod contracts (@student-os/shared).
deploy/      Modal deploy scripts (backend, embed endpoint, one-off jobs).
supabase/    SQL migrations (forward-only).
ios/         SwiftUI app (not needed for the web copy).
```

The backend does NOT run on Railway. Railway only serves the Next.js web app. The
backend and all the model work live on Modal. The web app talks to the Modal backend
over HTTP (`NEXT_PUBLIC_BACKEND_URL`).

---

## How the main features work

**Study chat (the core).** `POST /chat` runs retrieval over three sources and feeds
the hits to the model with instructions to answer only from that context and cite each
claim:

- `resource_chunks` - the course primers (the physical book, OCR'd into text) plus the
  per-session schedule pages. This is the shared knowledge base.
- `materials` - the user's own Canvas files (readings, cases), when Canvas is connected.
- `transcript_chunks` - lecture transcripts, when the user records lectures.

Retrieval is **hybrid**: semantic (embed the question with bge, rank chunks by cosine
similarity) plus keyword (Postgres full-text search) as a backstop, deduped. Semantic
is what lets a paraphrased question ("when does debt become unsustainable?") find the
right passage even when the wording differs from the book. The answer comes back with
`[P1]`/`[M2]`/`[L1]` labels that the web renders as clickable citation chips.

**Session awareness.** Each class session's detail lives on a Canvas *Page* (topic,
assigned readings, "refresher Primer 6"). The Canvas sync follows the calendar event ->
linked Page, pulls that text, and stores it as a searchable `resource_chunks` row
tagged `Session N schedule`. So "I'm on session 8, what primer do I need?" just works,
and it refreshes automatically on the 6-hour sync.

**Textbook reader.** `GET /textbook` groups the primer chunks into clean chapters (by
topic, in reading order) and the web renders them in a slide-in reader with book
typography and call-out boxes. Clicking a primer citation in the chat opens the reader
to that primer.

**Analytics.** A tiny privacy-light beacon (`POST /track`) logs a row per page view;
`GET /stats` aggregates it; `/stats` page shows totals, a 14-day chart, top pages and
sources. Self-hosted in the same DB, no third party.

**Cost control.** The Gemma endpoint is the only expensive thing (a GPU). It is
scale-to-zero, so it costs ~$0 when idle. The trade is a ~90-150s cold start on the
first question after idle; the chat retries through it so it reads as "slow", not an
error. There is an optional keep-warm (ping the model on a schedule) if you want the
first question to always be fast, but that keeps a GPU alive and costs real money.

---

## Copy it: step by step

You need accounts on **GitHub**, **Supabase**, **Modal**, and **Railway**. The chat
model can be any OpenAI-compatible endpoint; the steps below use a Modal LLM endpoint.

### 0. Clone and install

```bash
git clone https://github.com/daniel04wawng/agentic-student-os
cd agentic-student-os
npm ci
npm run build   # builds the shared package + backend
```

### 1. Database (Supabase)

1. Create a Supabase project.
2. Grab the **session pooler** connection string (not the transaction pooler, which
   breaks prepared statements and DDL, and not the IPv6-only direct connection). It
   looks like `postgresql://postgres.<ref>:<pwd>@aws-0-<region>.pooler.supabase.com:5432/postgres`.
3. Apply every file in `supabase/migrations/` in order. There is no migration runner;
   a tiny script that runs each file in a transaction and records it in a
   `schema_migrations` table is enough.

### 2. Chat model (Modal LLM endpoint)

Deploy an OpenAI-compatible chat model. The easiest path is Modal's managed LLM
endpoint (`modal endpoint ...` / the dashboard) with a Gemma or similar instruct model.
Note two things:

- The base URL (becomes `MODAL_MODEL_URL`).
- The bearer token (becomes `MODAL_MODEL_TOKEN`).

Set it to scale to zero when idle, or your bill runs while it is up.

### 3. Embedding endpoint (Modal)

```bash
# random shared token so the endpoint can't be called blindly
modal secret create student-os-embed-env EMBED_TOKEN=<random-hex>
modal deploy deploy/modal_embed.py
```

This serves `bge-small-en-v1.5` on CPU, kept warm (pennies). Copy the printed URL and
make a second secret the backend will read:

```bash
modal secret create student-os-embed-client-env \
  EMBED_URL=<the printed embed url> EMBED_TOKEN=<same random-hex>
```

### 4. Backend secrets (Modal)

```bash
modal secret create student-os-backend-env \
  DATABASE_URL=<supabase session pooler url> \
  CANVAS_BASE_URL=<your school's canvas url> CANVAS_API_TOKEN=<your canvas token> \
  MODEL_PROVIDER=modal MODEL_NAME=<your model id> \
  MODAL_MODEL_URL=<chat model url> MODAL_MODEL_TOKEN=<chat model token> \
  BACKEND_HOST=0.0.0.0 BACKEND_PORT=3000 PREP_SCHEDULER=0
```

(Deepgram, Composio/Google, and the self-rolled auth secrets are optional and only
needed for lecture transcription, Google Drive, and sign-in respectively.)

### 5. Deploy the backend (Modal)

```bash
modal deploy deploy/modal_backend.py
```

This builds the monorepo inside the image and runs the Fastify server as a
scale-to-zero web endpoint, plus scheduled jobs (Canvas sync every 6h, class prep,
lecture notes every 3 min, etc). Copy the printed serve URL. That is your backend.

Note: Modal caps free workspaces at 5 scheduled functions. The web upload is excluded
from the backend image (`web/` is ignored) or the upload gets too large.

### 6. Load content

- **Course primers (the textbook):** photograph or scan the book, OCR the pages (the
  repo used Apple Vision via a small Swift script; any OCR works), then chunk and insert
  into `resource_chunks` tagged to the course. Embed them with the backfill job
  (`modal run deploy/modal_embed.py::backfill`). Table/figure pages OCR badly; the repo
  re-transcribes those with the model's vision (`deploy/modal_ocr.py`).
- **Canvas material + sessions:** once `CANVAS_*` is set, the 6-hour sync pulls course
  files, the per-session schedule pages, and deadlines automatically.

### 7. Deploy the web app (Railway)

This is the one with sharp edges. The web app is a **standalone Next.js app, not an npm
workspace**, and it is served by a repo-root `railway.toml`.

1. Create a **new** Railway service from the GitHub repo. Use a fresh service: an older
   service can have a dashboard "Custom Build Command" that silently overrides
   `railway.toml` and builds the wrong thing.
2. The repo-root `railway.toml` builds `web/` with Next's standalone output and starts
   it. It also sets a health check so deploys report success instead of flapping.
3. Set `NEXT_PUBLIC_BACKEND_URL` to your Modal backend serve URL.
4. (Optional) Set `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` + `CLERK_SECRET_KEY` to turn on
   login; without them the chat is public.
5. `railway domain` to get a public URL. `/` redirects straight to `/chat`.

Deploy with a **single trigger** (either a git push OR `railway up`, not both at once):
two overlapping deploys race and one gets marked "failed" even though the site is fine.

---

## Digitizing the textbook (OCR the whole book)

The course primers only existed as a physical spiral-bound book, so the whole thing
had to be turned into searchable text. The pipeline:

1. **Photograph every page.** ~137 phone photos, one per page. (Shot at a slight angle
   on a desk, which matters later.)
2. **OCR each page** with Apple Vision (`scripts/ocr.swift`, macOS, free, on-device).
   It reads each page and sorts the detected text into reading order. One `.txt` per page.
3. **Clean the text.** OCR sometimes reads letters as look-alike characters from other
   alphabets (for example "Box" comes out as "вох"). Any non-Latin character in an
   English book is an error, so they get mapped back to their Latin look-alike.
4. **Chunk and load** into the `resource_chunks` table, one row per page, tagged to the
   course, keeping the page's section heading when the OCR caught it
   (`scripts/ingest_primers.mjs`).
5. **Embed** every chunk so semantic search works (`modal run deploy/modal_embed.py::backfill`).
6. **Fix the table/figure pages.** Plain OCR reads multi-column tables out of order and
   scrambles them. A heuristic flags those pages (lots of short, cell-like lines), and
   they get re-transcribed by the chat model's **vision** ability, which reads tables in
   the right order (`deploy/modal_ocr.py`). The clean text replaces the scrambled rows.

The payoff is two things from one source: the chat can quote the book accurately, and
the app has a readable in-app "textbook" of the primers.

## Why it is built this way (the decisions you can speak to)

If someone asks "how did you build this?", this is the reasoning behind each choice.

- **One monorepo with contract-first shared types.** The zod schemas in `packages/shared`
  are the single source of truth, generated into types the backend and (optionally)
  the Swift/iOS side both use, so the API contract can't drift between client and server.
- **Backend on Modal, scale-to-zero.** There is no server to keep running or patch. It
  costs ~$0 when nobody is using it and wakes on the first request. Background jobs
  (Canvas sync, class prep, lecture notes) run as scheduled functions instead of an
  always-on loop.
- **Web split out onto Railway.** The web app is a thin Next.js client that just calls
  the backend, so it deploys and scales on its own cheaply, independent of the model.
- **Retrieval is hybrid on purpose.** Semantic search (embeddings) catches questions
  phrased differently from the book. Keyword search catches exact terms, names, and
  things like "Session 8" that must match literally. Using both, then deduping, is more
  reliable than either alone.
- **Answers are grounded and cited.** The model is told to answer only from the retrieved
  context and to cite each claim. That is what makes it trustworthy for studying: if the
  material doesn't cover something, it says so instead of making it up.
- **The class schedule is treated as data, not hardcoded.** Session -> primer/reading
  mappings come from the live Canvas pages, so the app stays correct as the term goes on
  without code changes.
- **Cost is a first-class constraint.** The GPU model is the only expensive part, so it
  scales to zero and the client retries through cold starts. Everything else (backend,
  embeddings, web, DB) is pennies. There is a self-hosted stats page so you can watch
  traffic, and the model spend is one `modal billing report` away.
- **Analytics are self-hosted.** Page views go to the same Postgres, not a third party,
  so there is no extra account, no extra cost, and nothing leaves your stack.

## Gotchas worth knowing (learned the hard way)

- **Railway dashboard build command beats `railway.toml`.** If a service was ever given
  a custom build command, it wins over the config file. Use a fresh service.
- **A `.railway/railway.ts` file shadows `railway.toml`.** If you ran `railway config
  init`, delete it, or Railway uses the (build-only, no start) IaC file.
- **Supabase: use the session pooler.** Transaction pooler breaks DDL/prepared
  statements; direct connection is IPv6-only and fails from many machines.
- **Embeddings are stored as `jsonb` arrays** and cosine is computed in app code (no
  pgvector). Fine at this scale; swap to pgvector + an HNSW index if it grows.
- **The chat model is ~99% of the cost.** Keep it scale-to-zero. Keep-warm is a GPU
  running 24/7.
- **Modal `web_server` buffers SSE**, so true token streaming does not reach the
  browser. The chat uses one-shot requests with a client-side "thinking" sequence.
- **Exclude `web/` and build caches from the Modal backend image upload**, or the
  upload is large enough to fail on a flaky connection.

---

## What each endpoint does (quick reference)

```
POST /chat            Ask a question, get a grounded answer + sources.
GET  /textbook        The primers as readable chapters (topic + blocks).
GET  /sessions        Class sessions around now.
POST /track           Log a page view (analytics beacon).
GET  /stats           Aggregated traffic stats.
GET  /health          Liveness.
```

Retrieval, prompts, and the Canvas sync all live under `backend/src/`
(`chat/`, `retrieval/`, `canvas/`, `classprep/`). The web app is all in `web/app/`.

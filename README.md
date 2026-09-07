# Agentic Student OS

Monorepo for an agentic student operating system. **PR 0 = repository foundation only.**
No domain logic (Canvas, events, transcription, agents, submissions) exists yet; those
arrive in later, individually-reviewable PRs.

## Layout

```
backend/            TS orchestration service (Fastify). Owns HTTP + workflows.
services/inference/ Python service (FastAPI). Future home of Modal / Gemma inference.
packages/shared/    Canonical cross-service contracts as zod -> JSON Schema.
ios/                SwiftUI app (Xcode project, synchronized-folder format).
.github/workflows/  CI (TS, Python, iOS project validation).
```

### Why hybrid (TS + Python)
Inngest / Composio / Deepgram are TS-first; Modal + local Gemma inference are
Python-first. The TS backend orchestrates; the Python service holds inference.
They share contracts via `packages/shared` (zod is the source of truth; JSON
Schema is generated for Python + Swift consumers).

## Foundations established here (later PRs must preserve)
- **Trace propagation**: every request carries an `x-trace-id` (validated UUID,
  minted if absent) bound to an async context so all logs correlate. Backend uses
  `AsyncLocalStorage`; Python uses `contextvars`.
- **Fail-fast config**: env is validated once at startup (zod / pydantic-settings).
- **Contract-first**: shared shapes are defined once and generated outward.

## Prerequisites
- Node >= 22 (`.nvmrc`)
- `uv` for the Python service
- Xcode 16+ for the iOS app (uses synchronized-folder project format)

## Develop
```bash
cp .env.example .env        # fill in later; PR 0 needs no secrets
make install                # npm install (shared + backend)
make py-install             # uv sync inference deps
make check                  # build + typecheck + lint + test across all three
```

Postgres/Supabase and provider credentials are **declared** in `.env.example`
but unused until the PR that wires each one. No secrets are committed.

"""Host the Fastify backend (API + background loops) on Modal.

Architecture: the API is a scale-to-zero web endpoint (PREP_SCHEDULER=0, no
in-process loops), so it costs ~$0 at idle. Three scheduled functions
(modal.Period) drive the background work via the one-shot `tick` entrypoint:
prep (every 30 min), Canvas sync (every 6h), and lecture notes (every 15 min).
The heavy model calls live in the ticks -- which run to completion -- never as
fire-and-forget on the web endpoint, where a scale-down could cut them off.

Deploy:
    modal secret create student-os-backend-env \
        DATABASE_URL=... CANVAS_BASE_URL=... CANVAS_API_TOKEN=... \
        DEEPGRAM_API_KEY=... COMPOSIO_API_KEY=... COMPOSIO_USER_ID=<your-composio-user-id> \
        MODEL_PROVIDER=modal MODEL_NAME=google/gemma-4-26B-A4B-it \
        MODAL_MODEL_URL=... MODAL_MODEL_TOKEN=... \
        BACKEND_HOST=0.0.0.0 BACKEND_PORT=3000 INNGEST_DEV=0 AUTO_SUBMIT=0
    modal deploy deploy/modal_backend.py

The web endpoint URL it prints becomes the app's BackendBaseURL.
"""

import subprocess

import modal

app = modal.App("student-os-backend")

# Build the whole monorepo (backend + shared workspace) inside the image.
image = (
    modal.Image.debian_slim()
    .apt_install("curl")
    .run_commands(
        "curl -fsSL https://deb.nodesource.com/setup_22.x | bash -",
        "apt-get install -y nodejs",
    )
    .add_local_dir(
        ".",
        "/app",
        copy=True,
        ignore=[
            "**/node_modules",
            "**/.git",
            "**/dist",
            "**/.next",
            "**/.turbo",
            "**/.venv",
            "**/DerivedData",
            "**/*.xcarchive",
            "ios/**",
            "web/**",
            ".railway/**",
            "**/.env",
            "**/__pycache__",
        ],
    )
    .run_commands("cd /app && npm ci && npm run build")
    # Recordings live on a persistent Volume, not the ephemeral container disk.
    # PREP_SCHEDULER=0: the web endpoint runs no in-process loops; the two
    # scheduled functions below drive prep + Canvas sync instead.
    .env({"RECORDINGS_DIR": "/data/recordings", "PREP_SCHEDULER": "0"})
)

SECRET = modal.Secret.from_name("student-os-backend-env")
# Auth secrets (AUTH_JWT_SECRET, CRED_ENC_KEY) live in a separate secret so the
# main one never has to be recreated. Present on serve -> the API enforces auth
# and mounts the /auth sign-in routes; present on the ticks -> they can decrypt
# per-user credentials in a later phase.
AUTH_SECRET = modal.Secret.from_name("student-os-auth-env")
# EMBED_URL + EMBED_TOKEN for semantic retrieval (the bge-small endpoint).
EMBED_SECRET = modal.Secret.from_name("student-os-embed-client-env")
# Persistent storage for uploaded lecture audio (survives container restarts).
audio_volume = modal.Volume.from_name("student-os-audio", create_if_missing=True)


@app.function(
    image=image,
    # AUTH_SECRET intentionally OFF here until a working signed-in build ships, so
    # the API stays open (legacy) and the current app keeps working. Re-add
    # AUTH_SECRET to enforce auth + mount /auth once build 10 sign-in is verified.
    secrets=[SECRET, EMBED_SECRET],
    volumes={"/data/recordings": audio_volume},
    timeout=600,
)
@modal.web_server(3000, startup_timeout=180)
def serve():
    # Scale-to-zero API. Binds 0.0.0.0:3000 (BACKEND_HOST/PORT from the secret).
    subprocess.Popen(["node", "backend/dist/index.js"], cwd="/app")


@app.function(image=image, secrets=[SECRET, AUTH_SECRET], schedule=modal.Period(minutes=30), timeout=1800)
def prep_tick():
    """Prepare upcoming classes ahead of time (every 30 min)."""
    subprocess.run(["node", "backend/dist/tick.js", "prep"], cwd="/app", check=False)


@app.function(image=image, secrets=[SECRET, AUTH_SECRET], schedule=modal.Period(hours=6), timeout=1800)
def canvas_tick():
    """Refresh Canvas courses / deadlines / materials (every 6h)."""
    subprocess.run(["node", "backend/dist/tick.js", "sync"], cwd="/app", check=False)


@app.function(
    image=image,
    secrets=[SECRET, AUTH_SECRET],
    volumes={"/data/recordings": audio_volume},  # reads uploaded audio to transcribe
    schedule=modal.Period(minutes=3),
    timeout=1800,
)
def lectures_tick():
    """Transcribe stored recordings and turn transcripts into AI notes.

    Runs every 3 min as the reliable backstop. The upload route already fires
    transcription + note generation in-process for near-instant (Granola-style)
    notes; this catches anything the scale-to-zero web container dropped.

    Keep-warm is OFF for cost: the Gemma B200 endpoint is ~99% of spend, so we
    let it scale to zero and accept a cold start on the first question. To trade
    cost for speed again, call _warm_model() here (or on a shorter schedule)."""
    subprocess.run(["node", "backend/dist/tick.js", "lectures"], cwd="/app", check=False)


@app.function(image=image, secrets=[SECRET, AUTH_SECRET], schedule=modal.Period(hours=2), timeout=1800)
def drafts_tick():
    """Draft answers for upcoming discussion assignments for the student to review (every 2h)."""
    subprocess.run(["node", "backend/dist/tick.js", "drafts"], cwd="/app", check=False)


@app.function(image=image, secrets=[SECRET, AUTH_SECRET], schedule=modal.Cron("0 0 * * *"), timeout=300)
def push_tick():
    """Evening APNs digest: 'prep ready for tomorrow's N classes' (~8pm Eastern)."""
    subprocess.run(["node", "backend/dist/tick.js", "push"], cwd="/app", check=False)


# --- Keep the chat model warm ----------------------------------------------
# The Gemma endpoint is scale-to-zero, so the first chat after a few idle minutes
# eats a long cold start (weights onto GPU). We ping it from lectures_tick (which
# already runs every 3 min) so an interactive question gets a fast answer instead
# of ~1-2 min, without adding a 6th scheduled function.
# NOTE: this keeps a GPU warm and so incurs continuous GPU cost. To stop it,
# remove the _warm_model() call in lectures_tick and redeploy. Warming is gated
# to skip ~2am-7am Eastern (07:00-12:00 UTC) to avoid paying overnight.
def _warm_model() -> None:
    """Ping the chat model so it stays loaded for interactive questions."""
    import datetime
    import json
    import os
    import urllib.request

    hour_utc = datetime.datetime.now(datetime.timezone.utc).hour
    if 7 <= hour_utc < 12:
        print("warm: quiet hours, skipping")
        return

    base = (os.environ.get("MODAL_MODEL_URL") or "").rstrip("/")
    if not base:
        print("warm: no MODAL_MODEL_URL")
        return
    if base.endswith("/chat/completions"):
        url = base
    elif base.endswith("/v1"):
        url = base + "/chat/completions"
    else:
        url = base + "/v1/chat/completions"

    payload = json.dumps(
        {
            "model": os.environ.get("MODEL_NAME", "gemma"),
            "messages": [{"role": "user", "content": "ping"}],
            "max_tokens": 1,
            "temperature": 0,
        }
    ).encode()
    headers = {"Content-Type": "application/json"}
    token = os.environ.get("MODAL_MODEL_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"

    req = urllib.request.Request(url, data=payload, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=110) as resp:
            print(f"warm: {resp.status}")
    except Exception as exc:  # noqa: BLE001 - best-effort keep-warm
        print(f"warm: error {exc}")

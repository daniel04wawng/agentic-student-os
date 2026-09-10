"""Host the Fastify backend (API + background schedulers) on Modal.

Why a persistent container: the backend runs in-process schedulers (auto-prep +
Canvas sync via setInterval), so it must stay alive rather than scale to zero.
`min_containers=1` keeps one CPU container warm. CPU-only, so it is far cheaper
than a GPU, but it IS always-on (roughly a few dollars a month of CPU time) --
that is the trade for having prep happen ahead of class without your Mac.

If you would rather pay $0 at idle, the alternative is scale-to-zero for the API
plus Modal scheduled functions (modal.Period) for the two loops; that needs a
one-shot tick entrypoint and is a follow-up.

Deploy:
    modal secret create student-os-backend-env \
        DATABASE_URL=... CANVAS_BASE_URL=... CANVAS_API_TOKEN=... \
        DEEPGRAM_API_KEY=... COMPOSIO_API_KEY=... COMPOSIO_USER_ID=daniel \
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
            "**/.venv",
            "**/DerivedData",
            "**/*.xcarchive",
            "ios/**",
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
# Persistent storage for uploaded lecture audio (survives container restarts).
audio_volume = modal.Volume.from_name("student-os-audio", create_if_missing=True)


@app.function(
    image=image,
    secrets=[SECRET],
    volumes={"/data/recordings": audio_volume},
    timeout=600,
)
@modal.web_server(3000, startup_timeout=180)
def serve():
    # Scale-to-zero API. Binds 0.0.0.0:3000 (BACKEND_HOST/PORT from the secret).
    subprocess.Popen(["node", "backend/dist/index.js"], cwd="/app")


@app.function(image=image, secrets=[SECRET], schedule=modal.Period(minutes=30), timeout=900)
def prep_tick():
    """Prepare upcoming classes ahead of time (every 30 min)."""
    subprocess.run(["node", "backend/dist/tick.js", "prep"], cwd="/app", check=False)


@app.function(image=image, secrets=[SECRET], schedule=modal.Period(hours=6), timeout=1800)
def canvas_tick():
    """Refresh Canvas courses / deadlines / materials (every 6h)."""
    subprocess.run(["node", "backend/dist/tick.js", "sync"], cwd="/app", check=False)

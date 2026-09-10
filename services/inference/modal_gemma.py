"""Serve gemma4:12b via Ollama on a Modal GPU, scale-to-zero for low cost.

Design goals:
- **Cheap.** The GPU container scales to zero after `SCALEDOWN` seconds idle, so
  you pay ONLY while actually generating (plus a short idle tail). No always-on
  GPU bill.
- **Zero rework.** The backend's existing OllamaModelProvider posts to
  `<OLLAMA_URL>/api/chat` with the exact structured-output settings we already
  validated (think=false, JSON-schema `format`, num_predict). We simply expose
  Ollama's API behind a secret path token, so nothing in the model layer changes
  and class prep keeps producing the worked answer.
- **Fast cold start.** The model weights are baked into the image at build time,
  so a cold container does not re-download ~7.6GB; it only loads into VRAM.

Cost math (approx, per-second billing, scale-to-zero):
- GPU "L4" ~= $0.80/hr. A 2-3 min prep ~= $0.03-0.04. A day of moderate use
  (~20 min of GPU) ~= $0.25. Modal's monthly free credits typically cover a
  student's usage, so in practice this is often ~$0.
- Cheaper knobs: set GPU = "T4" (~$0.59/hr, slower) or MODEL = "gemma4:e4b"
  (smaller/faster, lower quality) if you want to trim further.

Deploy:
    pip install modal
    modal token new                     # one-time, links your Modal account
    modal secret create gemma-token GEMMA_TOKEN=<a-long-random-string>
    modal deploy services/inference/modal_gemma.py

Then in backend/.env:
    MODEL_PROVIDER=ollama
    OLLAMA_URL=https://<workspace>--student-os-gemma-serve.modal.run/<GEMMA_TOKEN>
    MODEL_NAME=gemma4:12b
"""

import os
import subprocess
import time

import modal

MODEL = "gemma4:12b"  # pulled by Ollama itself; no HuggingFace token/license needed
GPU = "L4"  # cheapest that comfortably fits the ~7.6GB Q4 weights; "T4" is cheaper/slower
SCALEDOWN = 60  # seconds idle before the GPU spins down (you pay ~$0 while down)

# Build the image: install Ollama, then bake the model weights into an image
# layer so cold starts never re-download them.
image = (
    modal.Image.debian_slim()
    .apt_install("curl", "zstd")  # zstd: required by the Ollama install script's extractor
    .pip_install("httpx", "fastapi")
    .run_commands("curl -fsSL https://ollama.com/install.sh | sh")
    .run_commands(
        # Start a temporary server, pull the model into the image layer, stop it.
        # Use $! + kill (shell builtins) since pkill/procps is not in the slim image.
        f"bash -c 'ollama serve & SRV=$!; sleep 8 && ollama pull {MODEL} && kill $SRV'"
    )
)

app = modal.App("student-os-gemma")


def _wait_for_ollama(timeout_s: int = 60) -> None:
    import httpx

    for _ in range(timeout_s * 2):
        try:
            httpx.get("http://localhost:11434/api/tags", timeout=1.0)
            return
        except Exception:
            time.sleep(0.5)
    raise RuntimeError("ollama did not become ready")


@app.function(
    image=image,
    gpu=GPU,
    scaledown_window=SCALEDOWN,
    timeout=900,
    secrets=[modal.Secret.from_name("gemma-token")],
)
@modal.asgi_app()
def serve():
    """Expose Ollama's API behind a secret path token: /<token>/api/chat, etc.

    The path-token scheme means the backend's OllamaModelProvider needs no
    changes: point OLLAMA_URL at .../<token> and it appends /api/chat itself.
    """
    import httpx
    from fastapi import FastAPI, HTTPException, Request, Response

    # Start Ollama for the life of this container (GPU is attached here).
    subprocess.Popen(["ollama", "serve"])
    _wait_for_ollama()

    token = os.environ["GEMMA_TOKEN"]
    web = FastAPI()

    async def _proxy(method: str, path: str, body: bytes | None) -> Response:
        url = f"http://localhost:11434/api/{path}"
        headers = {"Content-Type": "application/json"}
        async with httpx.AsyncClient(timeout=900.0) as client:
            if method == "POST":
                r = await client.post(url, content=body, headers=headers)
            else:
                r = await client.get(url)
        return Response(content=r.content, status_code=r.status_code, media_type="application/json")

    @web.post("/{tok}/api/{path:path}")
    async def post(tok: str, path: str, request: Request):
        if tok != token:
            raise HTTPException(status_code=401, detail="bad token")
        return await _proxy("POST", path, await request.body())

    @web.get("/{tok}/api/{path:path}")
    async def get(tok: str, path: str):
        if tok != token:
            raise HTTPException(status_code=401, detail="bad token")
        return await _proxy("GET", path, None)

    return web

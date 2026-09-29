"""Tiny CPU embedding endpoint for semantic retrieval.

The study chat and prep retrieval need to find the *relevant* primer passages,
not just keyword matches. This serves a small, strong sentence-embedding model
(BAAI/bge-small-en-v1.5, 384-dim) over HTTP so the Node backend can embed a
query and rank chunks by cosine similarity.

Kept warm (min_containers=1) on CPU so query-time embedding has no cold start;
this is pennies, unlike the GPU chat model. The model is baked into the image so
containers never download weights at runtime.

Deploy:
    modal secret create student-os-embed-env EMBED_TOKEN=<random-token>
    modal deploy deploy/modal_embed.py

Then set EMBED_URL (the printed URL) + EMBED_TOKEN in student-os-backend-env.
"""

import os

import modal

app = modal.App("student-os-embed")

MODEL_ID = "BAAI/bge-small-en-v1.5"


def _download_model() -> None:
    # Bake weights into the image layer so runtime containers start instantly.
    from sentence_transformers import SentenceTransformer

    SentenceTransformer(MODEL_ID)


image = (
    modal.Image.debian_slim()
    .pip_install(
        "sentence-transformers==3.3.1",
        "fastapi[standard]==0.115.6",
        "psycopg[binary]==3.2.3",
    )
    # Download + bake weights while the build still has network...
    .run_function(_download_model)
    # ...then force offline so runtime containers never hit the network.
    .env({"HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1"})
)

SECRET = modal.Secret.from_name("student-os-embed-env")

with image.imports():
    from sentence_transformers import SentenceTransformer

    _model: "SentenceTransformer | None" = None


def _get_model() -> "SentenceTransformer":
    global _model
    if _model is None:
        _model = SentenceTransformer(MODEL_ID)
    return _model


@app.function(
    image=image,
    secrets=[SECRET],
    min_containers=1,  # stay warm: no query-time cold start (cheap on CPU)
    scaledown_window=600,
    timeout=120,
)
@modal.concurrent(max_inputs=8)
@modal.fastapi_endpoint(method="POST")
def embed(payload: dict) -> dict:
    """POST {texts: [str], mode: "query"|"passage"} -> {vectors: [[float]]}.

    bge models want a short instruction prefix on *queries* (not passages) for
    best retrieval; we add it here based on `mode`.
    """
    from fastapi import HTTPException

    expected = os.environ.get("EMBED_TOKEN")
    # Auth via Authorization header is added by the ASGI layer; enforce a shared
    # token passed in the body as a fallback so this can't be called blindly.
    if expected and payload.get("token") != expected:
        raise HTTPException(status_code=401, detail="bad token")

    texts = payload.get("texts") or []
    if not isinstance(texts, list) or not all(isinstance(t, str) for t in texts):
        raise HTTPException(status_code=400, detail="texts must be a list of strings")
    if not texts:
        return {"vectors": []}

    mode = payload.get("mode", "passage")
    if mode == "query":
        prefix = "Represent this sentence for searching relevant passages: "
        texts = [prefix + t for t in texts]

    model = _get_model()
    vectors = model.encode(texts, normalize_embeddings=True, batch_size=32)
    return {"vectors": [v.tolist() for v in vectors]}


@app.function(
    image=image,
    # DATABASE_URL comes from the backend's secret so the credential never leaves
    # Modal. Run: modal run deploy/modal_embed.py::backfill
    secrets=[modal.Secret.from_name("student-os-backend-env")],
    timeout=1800,
)
def backfill(table: str = "resource_chunks") -> None:
    """Add the embedding column (if missing) and embed every unembedded row.

    Idempotent: only rows with NULL embedding are processed, so it is safe to
    re-run after ingesting more chunks. Embeddings are stored as jsonb arrays to
    match the existing transcript_chunks pattern (cosine is computed in app
    code)."""
    import json
    import os

    import psycopg

    if table not in {"resource_chunks", "transcript_chunks", "materials"}:
        raise ValueError(f"refusing unknown table {table!r}")

    model = _get_model()
    dsn = os.environ["DATABASE_URL"]
    with psycopg.connect(dsn, autocommit=True) as conn:
        with conn.cursor() as cur:
            cur.execute(f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS embedding jsonb")
            cur.execute(f"SELECT id, text FROM {table} WHERE embedding IS NULL AND text IS NOT NULL")
            rows = cur.fetchall()
            print(f"{table}: {len(rows)} rows to embed")
            BATCH = 64
            done = 0
            for i in range(0, len(rows), BATCH):
                batch = rows[i : i + BATCH]
                vecs = model.encode(
                    [r[1] for r in batch], normalize_embeddings=True, batch_size=32
                )
                with conn.cursor() as w:
                    for (rid, _text), vec in zip(batch, vecs):
                        w.execute(
                            f"UPDATE {table} SET embedding = %s::jsonb WHERE id = %s",
                            [json.dumps(vec.tolist()), rid],
                        )
                done += len(batch)
                print(f"  embedded {done}/{len(rows)}")
    print("done")

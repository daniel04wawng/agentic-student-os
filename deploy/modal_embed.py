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
    secrets=[modal.Secret.from_name("student-os-backend-env")],
    timeout=900,
)
def ingest_sessions() -> None:
    """Fetch each GMM session's Canvas detail page (topic + assigned readings +
    refresher primer) and store it as embedded, searchable resource_chunks so the
    chat can answer 'I'm on session 8, what primer do I need?'. Idempotent."""
    import html
    import json
    import os
    import re
    import urllib.request

    import psycopg

    base = (os.environ.get("CANVAS_BASE_URL") or "").rstrip("/")
    token = os.environ.get("CANVAS_API_TOKEN")

    def canvas_get(path: str) -> dict:
        req = urllib.request.Request(
            f"{base}{path}", headers={"Authorization": f"Bearer {token}"}
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read())

    def strip_html(s: str) -> str:
        s = re.sub(r"<script[\s\S]*?</script>", " ", s, flags=re.I)
        s = re.sub(r"<style[\s\S]*?</style>", " ", s, flags=re.I)
        s = re.sub(r"<li[^>]*>", "\n- ", s, flags=re.I)
        s = re.sub(r"<(p|br|div|h\d|tr)[^>]*>", "\n", s, flags=re.I)
        s = re.sub(r"<[^>]+>", " ", s)
        s = html.unescape(s)
        s = re.sub(r"[ \t]+", " ", s)
        s = re.sub(r"\n\s*\n\s*\n+", "\n\n", s)
        return s.strip()

    model = _get_model()
    with psycopg.connect(os.environ["DATABASE_URL"], autocommit=True) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id FROM courses WHERE name ILIKE '%Global Macro%' OR code ILIKE '%7096%' LIMIT 1"
            )
            course_id = cur.fetchone()[0]
            cur.execute(
                "SELECT title, starts_at, metadata FROM sessions WHERE course_id=%s AND metadata ? 'canvas_event_id' ORDER BY starts_at",
                [course_id],
            )
            sessions = cur.fetchall()
            # Clear prior session-schedule chunks so this is idempotent.
            cur.execute(
                "DELETE FROM resource_chunks WHERE course_id=%s AND source_title LIKE 'Session %%schedule'",
                [course_id],
            )

            inserted = 0
            for title, starts_at, meta in sessions:
                event_id = meta.get("canvas_event_id")
                num_m = re.search(r"Session\s+(\d+)", title or "")
                if not event_id or not num_m:
                    continue
                snum = num_m.group(1)
                try:
                    ev = canvas_get(f"/api/v1/calendar_events/{event_id}")
                    desc = ev.get("description") or ""
                    pm = re.search(r"/courses/(\d+)/pages/([^\"'?]+)", desc)
                    if not pm:
                        print(f"Session {snum}: no page link")
                        continue
                    page = canvas_get(f"/api/v1/courses/{pm.group(1)}/pages/{pm.group(2)}")
                    text = strip_html(page.get("body") or "")
                    if len(text) < 40:
                        print(f"Session {snum}: page empty")
                        continue
                    date = starts_at.date().isoformat() if starts_at else ""
                    body = f"Session {snum} ({date}) - {page.get('title') or title}\n\n{text}"
                    vec = model.encode([body[:2000]], normalize_embeddings=True)[0].tolist()
                    cur.execute(
                        """INSERT INTO resource_chunks (course_id, source_title, section, chunk_index, text, embedding)
                           VALUES (%s, %s, %s, 0, %s, %s::jsonb)""",
                        [course_id, f"Session {snum} schedule", date, body, json.dumps(vec)],
                    )
                    inserted += 1
                    print(f"Session {snum}: ingested {len(text)} chars")
                except Exception as exc:  # noqa: BLE001
                    print(f"Session {snum}: error {exc}")
            print(f"\nDONE: {inserted} session detail pages ingested")


@app.function(
    image=image,
    secrets=[modal.Secret.from_name("student-os-backend-env")],
    timeout=120,
)
def migrate_pageviews() -> None:
    """Create the pageviews table (self-hosted web analytics)."""
    import os

    import psycopg

    with psycopg.connect(os.environ["DATABASE_URL"], autocommit=True) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """CREATE TABLE IF NOT EXISTS pageviews (
                     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                     path text NOT NULL,
                     referrer text,
                     visitor text,
                     created_at timestamptz NOT NULL DEFAULT now()
                   )"""
            )
            cur.execute(
                "CREATE INDEX IF NOT EXISTS pageviews_created_idx ON pageviews (created_at)"
            )
    print("pageviews ready")


@app.function(
    image=image,
    secrets=[modal.Secret.from_name("student-os-backend-env")],
    timeout=300,
)
def inspect_topics() -> None:
    """Show sections + first lines per primer, to derive human topic titles."""
    import os
    import re

    import psycopg

    def label(t):
        if not t:
            return "Primer"
        m = re.search(r"Primer\s+(\d{1,2})", t, re.I)
        if not m:
            return t.strip()
        n = m.group(1)
        if len(n) == 2 and n[0] == "8":
            n = "0" + n[1]
        return f"Primer {n.zfill(2)}"

    with psycopg.connect(os.environ["DATABASE_URL"], autocommit=True) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT source_title, section, text, chunk_index FROM resource_chunks WHERE source_title NOT LIKE 'Session %% schedule' ORDER BY chunk_index"
            )
            rows = cur.fetchall()
    seen = {}
    for st, sec, text, _ in rows:
        key = label(st)
        if key not in seen:
            seen[key] = {"sections": set(), "first": (text or "")[:160]}
        if sec:
            seen[key]["sections"].add(sec[:60])
    for k in sorted(seen):
        print(f"\n{k}:")
        print("  first:", seen[k]["first"].replace("\n", " "))
        print("  sections:", list(seen[k]["sections"])[:6])


@app.function(
    image=image,
    secrets=[modal.Secret.from_name("student-os-backend-env")],
    timeout=600,
)
def clean_ocr() -> None:
    """Fix OCR homoglyphs in the primer text (Cyrillic look-alikes the OCR
    mistook for Latin, e.g. 'вох' -> 'box'). Any Cyrillic in this English
    textbook is an OCR error, so mapping the visual look-alikes to Latin is safe.
    Updates resource_chunks in place (skips the session-schedule rows)."""
    import os

    import psycopg

    # Cyrillic -> visually-identical Latin.
    homoglyphs = {
        "а": "a", "в": "b", "е": "e", "к": "k", "м": "m", "н": "h", "о": "o",
        "р": "p", "с": "c", "т": "t", "у": "y", "х": "x", "ѕ": "s", "і": "i",
        "ј": "j", "ԁ": "d", "ɡ": "g", "А": "A", "В": "B", "Е": "E", "К": "K",
        "М": "M", "Н": "H", "О": "O", "Р": "P", "С": "C", "Т": "T", "У": "Y",
        "Х": "X", "І": "I", "Ј": "J", "Ѕ": "S",
    }
    table = {ord(k): v for k, v in homoglyphs.items()}

    with psycopg.connect(os.environ["DATABASE_URL"], autocommit=True) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, text FROM resource_chunks WHERE source_title IS NULL OR source_title NOT LIKE 'Session %% schedule'"
            )
            rows = cur.fetchall()
            changed = 0
            for rid, text in rows:
                cleaned = (text or "").translate(table)
                if cleaned != text:
                    cur.execute(
                        "UPDATE resource_chunks SET text = %s WHERE id = %s", [cleaned, rid]
                    )
                    changed += 1
            print(f"cleaned {changed}/{len(rows)} primer chunks")


@app.function(
    image=image,
    secrets=[modal.Secret.from_name("student-os-backend-env")],
    timeout=300,
)
def inspect_event() -> None:
    """Does the Canvas calendar event for Session 8 carry the detail text?"""
    import json
    import os
    import urllib.request

    import psycopg

    with psycopg.connect(os.environ["DATABASE_URL"], autocommit=True) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT title, metadata FROM sessions WHERE title ILIKE '%Session 8%' LIMIT 1"
            )
            row = cur.fetchone()
    print("session:", row[0] if row else None, "meta:", row[1] if row else None)
    if not row:
        return
    event_id = row[1].get("canvas_event_id")
    base = (os.environ.get("CANVAS_BASE_URL") or "").rstrip("/")
    token = os.environ.get("CANVAS_API_TOKEN")
    url = f"{base}/api/v1/calendar_events/{event_id}"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read())
        print("EVENT title:", data.get("title"))
        desc = data.get("description") or ""
        print("EVENT description length:", len(desc))
        print("DESCRIPTION (first 1500 chars):\n", desc[:1500])
    except Exception as exc:  # noqa: BLE001
        print("canvas fetch error:", exc)


@app.function(
    image=image,
    secrets=[modal.Secret.from_name("student-os-backend-env")],
    timeout=300,
)
def inspect() -> None:
    """One-off: what session/material data exists for the GMM course?"""
    import os

    import psycopg

    with psycopg.connect(os.environ["DATABASE_URL"], autocommit=True) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, name FROM courses WHERE name ILIKE '%macro%' OR name ILIKE '%GMM%' OR code ILIKE '%7096%' ORDER BY name"
            )
            courses = cur.fetchall()
            print("COURSES:", courses)
            for cid, ctitle in courses:
                cur.execute(
                    "SELECT title, starts_at, metadata FROM sessions WHERE course_id=%s ORDER BY starts_at LIMIT 12",
                    [cid],
                )
                rows = cur.fetchall()
                print(f"\n== {ctitle} sessions ({len(rows)} shown) ==")
                for t, s, meta in rows:
                    mk = list(meta.keys()) if isinstance(meta, dict) else meta
                    print(f"  {s} | {t} | meta_keys={mk}")
            # Is the per-session detail text ingested anywhere?
            for tbl, col in [("materials", "title"), ("resource_chunks", "source_title")]:
                cur.execute(
                    f"SELECT {col}, left(text,120) FROM {tbl} WHERE text ILIKE '%session 8%' OR text ILIKE '%optional refresher%' LIMIT 5"
                )
                hits = cur.fetchall()
                print(f"\n{tbl} rows mentioning 'session 8'/'refresher': {len(hits)}")
                for h in hits:
                    print("   ", h[0], "::", h[1])


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

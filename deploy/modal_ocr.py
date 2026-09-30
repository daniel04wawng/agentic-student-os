"""Re-transcribe the scrambled (table/figure) primer pages with a vision model
and update their resource_chunks. See ocr-fix/ for the flagged images.

Run:
    modal run deploy/modal_embed.py::... first to know which pages.
    modal run deploy/modal_ocr.py::test          # probe Gemma vision on 1 page
    modal run deploy/modal_ocr.py::run            # transcribe all + update DB
"""

import base64
import json
import os

import modal

app = modal.App("student-os-ocr")

image = (
    modal.Image.debian_slim()
    .pip_install("psycopg[binary]==3.2.3")
    .add_local_dir(
        "/private/tmp/claude-501/-Users-daniel04wang/7ce4d563-4084-4eb5-8da6-1cc23264f5af/scratchpad/ocr-fix",
        "/imgs",
        copy=True,
    )
)

SECRET = modal.Secret.from_name("student-os-backend-env")

PROMPT = (
    "You are transcribing one page of a printed economics textbook (photographed "
    "at a slight angle). Output the page's text in natural reading order as clean "
    "plain text. If the page contains a table, render each row on its own line as "
    "'Row label - column2; column3; column4' so the associations are preserved. "
    "Transcribe every word exactly; do not summarize, add, or comment. Ignore the "
    "running header/footer and page number."
)


def _model_chat_url() -> str:
    base = (os.environ.get("MODAL_MODEL_URL") or "").rstrip("/")
    if base.endswith("/chat/completions"):
        return base
    if base.endswith("/v1"):
        return base + "/chat/completions"
    return base + "/v1/chat/completions"


def _transcribe(img_path: str) -> str:
    import urllib.request

    with open(img_path, "rb") as fh:
        b64 = base64.b64encode(fh.read()).decode()
    body = json.dumps(
        {
            "model": os.environ.get("MODEL_NAME", "gemma"),
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": PROMPT},
                        {
                            "type": "image_url",
                            "image_url": {"url": f"data:image/jpeg;base64,{b64}"},
                        },
                    ],
                }
            ],
            "max_tokens": 2000,
            "temperature": 0,
        }
    ).encode()
    headers = {"Content-Type": "application/json"}
    tok = os.environ.get("MODAL_MODEL_TOKEN")
    if tok:
        headers["Authorization"] = f"Bearer {tok}"
    import time
    import urllib.error

    for attempt in range(80):  # ~ up to ~10 min of cold-start warm-up
        req = urllib.request.Request(
            _model_chat_url(), data=body, headers=headers, method="POST"
        )
        try:
            with urllib.request.urlopen(req, timeout=300) as resp:
                data = json.loads(resp.read())
            return data["choices"][0]["message"]["content"]
        except urllib.error.HTTPError as e:
            if e.code in (502, 503) and attempt < 79:
                time.sleep(8)
                continue
            raise
    raise RuntimeError("model never became ready")


@app.function(image=image, secrets=[SECRET], timeout=600)
def test() -> None:
    imgs = sorted(os.listdir("/imgs"))
    print(f"{len(imgs)} images. Probing vision on: {imgs[0]}")
    try:
        out = _transcribe(f"/imgs/{imgs[0]}")
        print("=== TRANSCRIPTION (first 900 chars) ===")
        print(out[:900])
    except Exception as exc:  # noqa: BLE001
        print("VISION FAILED:", exc)


@app.function(image=image, secrets=[SECRET], timeout=5400)
def run() -> None:
    """Transcribe every flagged page and replace its resource_chunks with clean
    vision text (embedding NULL). Run backfill afterwards to re-embed."""
    import psycopg

    imgs = sorted(os.listdir("/imgs"))
    ok = fail = 0
    with psycopg.connect(os.environ["DATABASE_URL"], autocommit=True) as conn:
        for i, img in enumerate(imgs):
            page_file = img[:-4] + ".txt"  # att.X.jpg -> att.X.txt
            try:
                text = _transcribe(f"/imgs/{img}").strip()
            except Exception as exc:  # noqa: BLE001
                print(f"[{i + 1}/{len(imgs)}] {img}: transcribe FAILED {exc}")
                fail += 1
                continue
            if len(text) < 40:
                print(f"[{i + 1}/{len(imgs)}] {img}: empty transcription, skip")
                fail += 1
                continue
            with conn.cursor() as cur:
                cur.execute(
                    """SELECT course_id, (array_agg(source_title))[1], (array_agg(section))[1],
                              min(chunk_index)
                       FROM resource_chunks WHERE metadata->>'page_file' = %s
                       GROUP BY course_id""",
                    [page_file],
                )
                row = cur.fetchone()
                if not row:
                    print(f"[{i + 1}/{len(imgs)}] {img}: no chunk for {page_file}")
                    fail += 1
                    continue
                course_id, source_title, section, cidx = row
                cur.execute(
                    "DELETE FROM resource_chunks WHERE metadata->>'page_file' = %s", [page_file]
                )
                cur.execute(
                    """INSERT INTO resource_chunks
                       (course_id, source_title, section, chunk_index, text, metadata, embedding)
                       VALUES (%s, %s, %s, %s, %s, %s::jsonb, NULL)""",
                    [
                        course_id,
                        source_title,
                        section,
                        cidx,
                        text,
                        json.dumps({"page_file": page_file, "vision": True}),
                    ],
                )
            ok += 1
            print(f"[{i + 1}/{len(imgs)}] {img}: {len(text)} chars -> updated")
    print(f"DONE: {ok} updated, {fail} failed. Now: modal run deploy/modal_embed.py::backfill")

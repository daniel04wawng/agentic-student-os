import json
from pathlib import Path

from fastapi.testclient import TestClient

from app.config import load_settings
from app.main import HealthResponse, create_app
from app.trace import TRACE_HEADER

client = TestClient(create_app(load_settings(log_level="error")))

SHARED_SCHEMA = (
    Path(__file__).resolve().parents[3]
    / "packages"
    / "shared"
    / "generated"
    / "health-response.schema.json"
)


def test_health_ok() -> None:
    res = client.get("/health")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "ok"
    assert body["service"] == "inference"
    # response header echoes the body trace id
    assert res.headers[TRACE_HEADER] == body["trace_id"]


def test_preserves_valid_trace_id() -> None:
    incoming = "22222222-2222-2222-2222-222222222222"
    res = client.get("/health", headers={TRACE_HEADER: incoming})
    assert res.json()["trace_id"] == incoming
    assert res.headers[TRACE_HEADER] == incoming


def test_replaces_malformed_trace_id() -> None:
    res = client.get("/health", headers={TRACE_HEADER: "garbage"})
    assert res.json()["trace_id"] != "garbage"


def test_local_model_matches_shared_schema_fields() -> None:
    """Guard: the hand-maintained model must not drift from the canonical schema."""
    if not SHARED_SCHEMA.exists():
        # Generated during `npm run shared:generate`; skip if not present locally.
        return
    schema = json.loads(SHARED_SCHEMA.read_text())
    definition = schema.get("definitions", {}).get("health-response", schema)
    schema_fields = set(definition.get("properties", {}).keys())
    model_fields = set(HealthResponse.model_fields.keys())
    assert model_fields == schema_fields

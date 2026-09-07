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


def _shape(props: dict[str, dict]) -> dict[str, dict]:
    """Reduce each property to the structural essentials we require to match:
    JSON type and enum members. Finer constraints (minLength, format, minimum)
    are intentionally not mirrored by the loose runtime model, so we ignore them.
    """
    return {
        name: {
            "type": spec.get("type"),
            "enum": sorted(spec["enum"]) if "enum" in spec else None,
        }
        for name, spec in props.items()
    }


def test_local_model_matches_shared_schema() -> None:
    """Guard: the hand-maintained model must not drift from the canonical schema
    in field set, JSON types, enum members, required-ness, or extra-field policy."""
    if not SHARED_SCHEMA.exists():
        # Generated during `npm run shared:generate`; skip if not present locally.
        return
    schema = json.loads(SHARED_SCHEMA.read_text())
    definition = schema.get("definitions", {}).get("health-response", schema)
    model_schema = HealthResponse.model_json_schema()

    assert _shape(model_schema["properties"]) == _shape(definition["properties"])
    assert set(model_schema.get("required", [])) == set(definition.get("required", []))
    # extra="forbid" <-> additionalProperties:false
    assert model_schema.get("additionalProperties") is False
    assert definition.get("additionalProperties") is False

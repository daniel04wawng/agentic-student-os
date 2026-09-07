"""FastAPI app for the inference service (PR 0 skeleton).

The `HealthResponse` model mirrors the canonical contract in
`packages/shared/generated/health-response.schema.json`. A later PR will
code-generate this model from that schema; for now it is kept in sync by hand
and covered by a test asserting the field set matches.
"""

from __future__ import annotations

import time
from typing import Literal

from fastapi import FastAPI, Request, Response
from pydantic import BaseModel, Field

from .config import Settings, load_settings
from .logging_config import configure_logging
from .trace import TRACE_HEADER, normalize_trace_id, set_trace_id

SERVICE_NAME = "inference"
VERSION = "0.0.0"


class HealthResponse(BaseModel):
    model_config = {"extra": "forbid"}

    status: Literal["ok", "degraded"]
    service: str
    version: str
    trace_id: str
    uptime_s: float = Field(ge=0)


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or load_settings()
    configure_logging(settings.log_level)
    started_at = time.monotonic()
    app = FastAPI(title="student-os-inference", version=VERSION)

    @app.middleware("http")
    async def trace_middleware(request: Request, call_next):  # type: ignore[no-untyped-def]
        trace_id = normalize_trace_id(request.headers.get(TRACE_HEADER))
        request.state.trace_id = trace_id
        set_trace_id(trace_id)
        response: Response = await call_next(request)
        response.headers[TRACE_HEADER] = trace_id
        return response

    @app.get("/health", response_model=HealthResponse)
    async def health(request: Request) -> HealthResponse:
        # Body trace_id comes from the SAME value echoed in the header
        # (request.state.trace_id), so the two can never diverge.
        return HealthResponse(
            status="ok",
            service=SERVICE_NAME,
            version=VERSION,
            trace_id=request.state.trace_id,
            uptime_s=time.monotonic() - started_at,
        )

    return app


app = create_app()

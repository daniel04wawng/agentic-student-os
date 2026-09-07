"""Trace-context propagation for the inference service.

Mirrors the backend's model: a `trace_id` is bound to a contextvar for the
duration of a request and injected into every log line, so logs correlate.
"""

from __future__ import annotations

import re
import uuid
from contextvars import ContextVar

TRACE_HEADER = "x-trace-id"

_trace_id: ContextVar[str | None] = ContextVar("trace_id", default=None)

_UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE
)


def current_trace_id() -> str | None:
    return _trace_id.get()


def set_trace_id(trace_id: str) -> None:
    _trace_id.set(trace_id)


def normalize_trace_id(incoming: str | None) -> str:
    """Accept a well-formed UUID, otherwise mint a fresh one."""
    if incoming and _UUID_RE.match(incoming):
        return incoming
    return str(uuid.uuid4())

"""Environment configuration, validated once at import via pydantic-settings.

PR 0 keeps this to runtime basics. Provider vars (Modal, etc.) are declared in
`.env.example` but intentionally NOT required here until their PR wires them.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

LogLevel = Literal["critical", "error", "warning", "info", "debug"]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    log_level: LogLevel = "info"
    inference_port: int = Field(default=8000, gt=0, le=65535)


def load_settings(**overrides: Any) -> Settings:
    """Load settings; raises pydantic ValidationError (a ValueError) on bad input."""
    return Settings(**overrides)

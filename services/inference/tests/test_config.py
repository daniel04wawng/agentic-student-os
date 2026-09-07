import pytest
from pydantic import ValidationError

from app.config import load_settings


def test_defaults() -> None:
    s = load_settings()
    assert s.log_level == "info"
    assert s.inference_port == 8000


def test_override() -> None:
    assert load_settings(inference_port=9001).inference_port == 9001


def test_rejects_out_of_range_port() -> None:
    with pytest.raises(ValidationError):
        load_settings(inference_port=70000)


def test_rejects_bad_log_level() -> None:
    with pytest.raises(ValidationError):
        load_settings(log_level="loud")

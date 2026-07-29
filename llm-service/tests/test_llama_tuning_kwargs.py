"""Prefill/KV tuning knobs are mapped onto whatever ``Llama.__init__`` the
installed llama-cpp-python accepts.

The CPU image pins llama-cpp-python 0.3.2 and the CUDA image 0.3.31, and
llama.cpp reworked the FlashAttention switch from a bool into a tri-state enum
in between. ``_optional_llama_kwargs`` therefore introspects the signature
instead of passing a fixed parameter set, and drops what it cannot map — a
tuning parameter must never keep the service from starting.
"""

from __future__ import annotations

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import main  # noqa: E402


class _OldLlama:
    """llama-cpp-python 0.3.2-style signature: bool ``flash_attn``."""

    def __init__(
        self,
        model_path: str,
        n_ctx: int = 512,
        n_batch: int = 512,
        n_ubatch: int = 512,
        flash_attn: bool = False,
        type_k: int | None = None,
        type_v: int | None = None,
        verbose: bool = True,
    ) -> None:  # pragma: no cover - never instantiated
        pass


class _NewLlama:
    """Newer signature: tri-state ``flash_attn_type``, no bool ``flash_attn``."""

    def __init__(
        self,
        model_path: str,
        n_ctx: int = 512,
        n_batch: int = 512,
        n_ubatch: int = 512,
        flash_attn_type: int = -1,
        type_k: int | None = None,
        type_v: int | None = None,
        verbose: bool = True,
    ) -> None:  # pragma: no cover - never instantiated
        pass


class _MinimalLlama:
    """A binding that knows none of the tuning parameters."""

    def __init__(self, model_path: str, n_ctx: int = 512) -> None:  # pragma: no cover
        pass


class _StubModule:
    """Stand-in for the ``llama_cpp`` module; only the constants matter."""

    LLAMA_FLASH_ATTN_TYPE_ENABLED = 1
    GGML_TYPE_Q8_0 = 8


@pytest.fixture
def tuning(monkeypatch):
    """Set the tuning env-derived module constants for one test."""

    def _apply(*, batch=512, ubatch=512, flash=False, kv="f16"):
        monkeypatch.setattr(main, "LLM_BATCH", batch)
        monkeypatch.setattr(main, "LLM_UBATCH", ubatch)
        monkeypatch.setattr(main, "LLM_FLASH_ATTN", flash)
        monkeypatch.setattr(main, "LLM_KV_TYPE", kv)

    return _apply


def test_defaults_map_batch_only(tuning):
    tuning()
    kwargs = main._optional_llama_kwargs(_StubModule, _OldLlama)
    assert kwargs == {"n_batch": 512, "n_ubatch": 512}


def test_gpu_profile_maps_onto_old_bool_flash_attn(tuning):
    tuning(batch=2048, ubatch=1024, flash=True, kv="q8_0")
    kwargs = main._optional_llama_kwargs(_StubModule, _OldLlama)
    assert kwargs == {
        "n_batch": 2048,
        "n_ubatch": 1024,
        "flash_attn": True,
        "type_k": 8,
        "type_v": 8,
    }


def test_gpu_profile_maps_onto_new_tristate_flash_attn(tuning):
    tuning(batch=2048, ubatch=1024, flash=True, kv="q8_0")
    kwargs = main._optional_llama_kwargs(_StubModule, _NewLlama)
    assert "flash_attn" not in kwargs
    assert kwargs["flash_attn_type"] == 1
    assert kwargs["type_k"] == kwargs["type_v"] == 8


def test_unknown_parameters_are_dropped_not_raised(tuning):
    """The whole point: an unmappable knob degrades to "not set"."""

    tuning(batch=2048, ubatch=1024, flash=True, kv="q8_0")
    assert main._optional_llama_kwargs(_StubModule, _MinimalLlama) == {}


def test_ggml_type_falls_back_when_binding_lacks_the_constant():
    class _NoConstants:
        pass

    # q5_1 is absent from the stub module → hard-coded ggml.h value.
    assert main._ggml_type(_NoConstants, "q5_1") == 7
    # Present on the stub → the binding's own value wins.
    assert main._ggml_type(_StubModule, "q8_0") == 8


def test_f16_kv_type_adds_no_kwargs(tuning):
    """f16 is llama.cpp's own default — don't pin it explicitly."""

    tuning(flash=True, kv="f16")
    kwargs = main._optional_llama_kwargs(_StubModule, _OldLlama)
    assert "type_k" not in kwargs and "type_v" not in kwargs


def test_env_bool_parsing():
    for raw in ("1", "true", "TRUE", "yes", "on"):
        os.environ["_TEST_FLAG"] = raw
        assert main._env_bool("_TEST_FLAG", False) is True
    for raw in ("0", "false", "no", "off", "nonsense"):
        os.environ["_TEST_FLAG"] = raw
        assert main._env_bool("_TEST_FLAG", True) is False
    # Absent and empty both fall back to the default (compose passes "" for
    # unset ${VAR:-} overrides).
    del os.environ["_TEST_FLAG"]
    assert main._env_bool("_TEST_FLAG", True) is True
    os.environ["_TEST_FLAG"] = ""
    assert main._env_bool("_TEST_FLAG", True) is True
    del os.environ["_TEST_FLAG"]

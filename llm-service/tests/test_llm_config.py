"""LlmConfig: environment loading, API input validation, and persistence.

The point of these is the precedence rule the whole feature rests on — an
activated configuration wins, but *only* when one exists, so a deployment
running on compose/.env keeps doing exactly that.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from llm_config import (
    ACTIVE_CONFIG_FILENAME,
    ConfigError,
    LlmConfig,
    active_config_path,
    clear_active,
    load_active,
    save_active,
)


def _minimal(**overrides) -> dict:
    return {"model_filename": "model.gguf", **overrides}


# ─── from_env ──────────────────────────────────────────────────────────────────


def test_from_env_uses_documented_defaults(monkeypatch):
    for var in (
        "LLM_MODEL_PATH", "LLM_BACKEND", "LLM_ACCELERATOR", "LLM_CTX", "LLM_GPU_LAYERS",
        "LLM_BATCH", "LLM_UBATCH", "LLM_FLASH_ATTN", "LLM_KV_TYPE", "LLM_NCMOE",
        "LLM_REASONING", "LLM_SERVER_URL", "MODELS_DIR",
    ):
        monkeypatch.delenv(var, raising=False)

    cfg = LlmConfig.from_env()

    assert cfg.model_path == Path("/models/qwen2.5-7b-instruct-q4_k_m.gguf")
    assert cfg.backend == "inproc"
    assert cfg.accelerator == "cpu"
    assert cfg.ctx == 8192
    assert cfg.batch == 512 and cfg.ubatch == 512
    assert cfg.flash_attn is False
    assert cfg.kv_type == "f16"
    assert cfg.n_cpu_moe == 0


def test_from_env_reads_the_gpu_profile(monkeypatch):
    monkeypatch.setenv("LLM_BACKEND", "server")
    monkeypatch.setenv("LLM_ACCELERATOR", "cuda")
    monkeypatch.setenv("LLM_CTX", "18000")
    monkeypatch.setenv("LLM_GPU_LAYERS", "-1")
    monkeypatch.setenv("LLM_BATCH", "2048")
    monkeypatch.setenv("LLM_FLASH_ATTN", "1")
    monkeypatch.setenv("LLM_KV_TYPE", "q8_0")
    monkeypatch.setenv("LLM_NCMOE", "32")
    monkeypatch.setenv("LLM_MODEL_EXTRA_URLS", "https://h/a.gguf https://h/b.gguf")

    cfg = LlmConfig.from_env()

    assert cfg.backend == "server"
    assert cfg.ctx == 18000
    assert cfg.gpu_layers == -1
    assert cfg.flash_attn is True
    assert cfg.kv_type == "q8_0"
    assert cfg.n_cpu_moe == 32
    assert cfg.extra_urls == ("https://h/a.gguf", "https://h/b.gguf")


def test_empty_env_value_falls_back_to_the_default(monkeypatch):
    """Compose passes ``${VAR:-}`` for unset overrides, which arrives as ""."""

    monkeypatch.setenv("LLM_CTX", "")
    monkeypatch.setenv("LLM_KV_TYPE", "")
    cfg = LlmConfig.from_env()
    assert cfg.ctx == 8192
    assert cfg.kv_type == "f16"


def test_invalid_env_is_rejected_at_load(monkeypatch):
    monkeypatch.setenv("LLM_BACKEND", "magic")
    with pytest.raises(ConfigError):
        LlmConfig.from_env()


# ─── from_dict ─────────────────────────────────────────────────────────────────


def test_from_dict_resolves_the_filename_against_models_dir():
    cfg = LlmConfig.from_dict(_minimal(), models_dir=Path("/vol"))
    assert cfg.model_path == Path("/vol/model.gguf")


@pytest.mark.parametrize("name", ["../escape.gguf", "/etc/passwd", "sub/dir.gguf", "..", "."])
def test_from_dict_rejects_anything_that_is_not_a_bare_name(name):
    """These arrive over HTTP; a path would let a request point the loader
    outside the models volume."""

    with pytest.raises(ConfigError):
        LlmConfig.from_dict({"model_filename": name}, models_dir=Path("/vol"))


def test_from_dict_requires_a_filename():
    with pytest.raises(ConfigError):
        LlmConfig.from_dict({"model_filename": "  "}, models_dir=Path("/vol"))


def test_from_dict_maps_the_database_column_names():
    cfg = LlmConfig.from_dict(
        _minimal(
            label="MoE",
            config_id=7,
            backend="server",
            accelerator="cuda",
            ctx_size=18000,
            gpu_layers=-1,
            batch_size=2048,
            ubatch_size=512,
            flash_attn=True,
            kv_type="q8_0",
            n_cpu_moe=32,
            reasoning="off",
            ready_timeout_s=1200,
            request_timeout_s=1200,
            extra_urls=["https://h/b.gguf"],
        ),
        models_dir=Path("/vol"),
    )

    assert (cfg.label, cfg.config_id) == ("MoE", 7)
    assert (cfg.backend, cfg.accelerator) == ("server", "cuda")
    assert (cfg.ctx, cfg.gpu_layers, cfg.batch) == (18000, -1, 2048)
    assert cfg.n_cpu_moe == 32
    assert cfg.server_ready_timeout == 1200
    assert cfg.extra_urls == ("https://h/b.gguf",)


def test_null_threads_means_let_the_backend_choose():
    cfg = LlmConfig.from_dict(_minimal(threads=None), models_dir=Path("/vol"))
    assert cfg.threads == 0


def test_unknown_keys_are_ignored():
    """The app sends whole rows; a new column must not break the service."""

    cfg = LlmConfig.from_dict(
        _minimal(created_at="2026-01-01", some_future_column=True), models_dir=Path("/vol")
    )
    assert cfg.model_path.name == "model.gguf"


@pytest.mark.parametrize(
    "payload",
    [
        {"backend": "magic"},
        {"accelerator": "tpu"},
        {"kv_type": "q3_k"},
        {"reasoning": "sometimes"},
        {"ctx_size": 0},
        {"ctx_size": 10_000_000},
        {"batch_size": 0},
        {"threads": -1},
        {"n_cpu_moe": -1},
        {"ready_timeout_s": 0},
        {"server_url": "ftp://host:8080"},
        # A micro-batch larger than the batch is not a thing llama.cpp accepts.
        {"batch_size": 512, "ubatch_size": 1024},
    ],
)
def test_invalid_values_are_rejected(payload):
    with pytest.raises(ConfigError):
        LlmConfig.from_dict(_minimal(**payload), models_dir=Path("/vol"))


def test_to_dict_round_trips():
    original = LlmConfig.from_dict(
        _minimal(label="x", backend="server", ctx_size=4096, n_cpu_moe=12, kv_type="q8_0"),
        models_dir=Path("/vol"),
    )
    again = LlmConfig.from_dict(original.to_dict(), models_dir=Path("/vol"))
    assert again == original


# ─── Persistence ───────────────────────────────────────────────────────────────


def test_no_file_means_no_persisted_config(tmp_path):
    """The precedence rule that keeps existing deployments on their .env."""

    assert load_active(tmp_path) is None


def test_save_then_load_round_trips(tmp_path):
    cfg = LlmConfig.from_dict(_minimal(label="saved", ctx_size=4096), models_dir=tmp_path)
    path = save_active(tmp_path, cfg)

    assert path == tmp_path / ACTIVE_CONFIG_FILENAME
    assert load_active(tmp_path) == cfg


def test_save_leaves_no_temporary_file_behind(tmp_path):
    """Written via a temp file and renamed, so a crash mid-write cannot leave a
    truncated config the next start would refuse."""

    save_active(tmp_path, LlmConfig.from_dict(_minimal(), models_dir=tmp_path))
    assert [p.name for p in tmp_path.iterdir()] == [ACTIVE_CONFIG_FILENAME]


def test_save_overwrites_the_previous_config(tmp_path):
    save_active(tmp_path, LlmConfig.from_dict(_minimal(label="first"), models_dir=tmp_path))
    save_active(tmp_path, LlmConfig.from_dict(_minimal(label="second"), models_dir=tmp_path))
    loaded = load_active(tmp_path)
    assert loaded is not None and loaded.label == "second"


def test_a_corrupt_file_raises_rather_than_returning_a_default(tmp_path):
    """main._resolve_startup_config catches this and falls back to the
    environment; silently returning a default here would hide the problem."""

    active_config_path(tmp_path).write_text("{not json", encoding="utf-8")
    with pytest.raises(ValueError):
        load_active(tmp_path)


def test_a_json_array_is_not_a_config(tmp_path):
    active_config_path(tmp_path).write_text(json.dumps([1, 2]), encoding="utf-8")
    with pytest.raises(ConfigError):
        load_active(tmp_path)


def test_clear_active_reports_whether_it_removed_anything(tmp_path):
    assert clear_active(tmp_path) is False
    save_active(tmp_path, LlmConfig.from_dict(_minimal(), models_dir=tmp_path))
    assert clear_active(tmp_path) is True
    assert load_active(tmp_path) is None

"""The GPU lease: /gpu/lend, /gpu/return and what ends a lease.

Stage 2 of documentation/plans/foto-aesthetik.md. The nightly aesthetic job
lends the card to the scorer and must find Gemma still answering on the
CPU meanwhile, the persisted configuration untouched, and the lease gone
the moment an admin reloads. Driven like test_model_admin_endpoints.py:
the loader is stubbed, the state machine is real.
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import main  # noqa: E402
from llm_config import LlmConfig, load_active, save_active  # noqa: E402
from model_downloads import DownloadManager  # noqa: E402


@pytest.fixture
def client():
    return TestClient(main.app)


@pytest.fixture
def volume(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "MODELS_DIR", tmp_path)
    monkeypatch.setattr(main, "_downloads", DownloadManager(tmp_path))
    return tmp_path


@pytest.fixture(autouse=True)
def _reset(monkeypatch):
    original_status = dict(main._reload_status)
    original_config = main._state["config"]
    original_source = main._state["config_source"]
    original_notice = main._state.get("backend_notice")
    main._lease_clear()
    yield
    main._reload_status.clear()
    main._reload_status.update(original_status)
    main._reload_running = False
    main._lease_clear()
    main._apply_config(original_config, source=original_source, notice=original_notice)
    main._state["embedder"] = None
    main._state["embedder_device"] = None


def _gpu_config(volume: Path, **overrides) -> LlmConfig:
    (volume / "gemma.gguf").write_bytes(b"x")
    data = {
        "label": "Gemma 4 GPU",
        "model_filename": "gemma.gguf",
        "backend": "server",
        "accelerator": "cuda",
        "ctx_size": 16384,
        "gpu_layers": 99,
        "n_cpu_moe": 20,
        "kv_type": "q8_0",
        "flash_attn": True,
        "config_id": 7,
        **overrides,
    }
    return LlmConfig.from_dict(data, models_dir=volume)


def _run_gpu(volume: Path, monkeypatch, **overrides) -> LlmConfig:
    """Put the service on a GPU configuration, as after an admin activation."""

    cfg = _gpu_config(volume, **overrides)
    main._apply_config(cfg, source="file", notice=None)
    save_active(volume, cfg)
    main._state["llm"] = object()
    monkeypatch.setattr(type(main._llama_server), "available", property(lambda self: True))
    return cfg


class FakeEmbedder:
    def __init__(self) -> None:
        self.devices: list[str] = []

    def to(self, device: str) -> "FakeEmbedder":
        self.devices.append(device)
        return self


def _wait(client, timeout: float = 10.0) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        body = client.get("/reload/status").json()
        if body["reload"]["state"] in {"ready", "error", "idle"}:
            return body
        time.sleep(0.02)
    raise AssertionError("reload did not settle")


# ─── cpu_twin ──────────────────────────────────────────────────────────────────


def test_the_twin_keeps_everything_but_the_card(volume):
    cfg = _gpu_config(volume)
    twin = main.cpu_twin(cfg)
    assert twin.gpu_layers == 0
    assert twin.n_cpu_moe == 0
    assert twin.accelerator == "cpu"
    assert twin.label == "Gemma 4 GPU (CPU)"
    # Same model, same context, same KV cache, same projector handling,
    # same timeouts: the twin must answer whatever the GPU config answered.
    assert twin.model_path == cfg.model_path
    assert twin.ctx == cfg.ctx
    assert twin.kv_type == cfg.kv_type
    assert twin.backend == cfg.backend
    assert twin.config_id == cfg.config_id
    assert twin.extra_urls == cfg.extra_urls
    twin.validate()


def test_an_unlabelled_environment_config_is_named_after_its_file(volume):
    cfg = _gpu_config(volume, label="")
    assert main.cpu_twin(cfg).label == "gemma.gguf (CPU)"


def test_the_twin_does_not_inherit_the_gpu_thread_count(volume, monkeypatch):
    # On the card 4 threads only feed the GPU; the twin has to use the cores.
    monkeypatch.delenv("LLM_CPU_THREADS", raising=False)
    monkeypatch.setattr(main.os, "sched_getaffinity", lambda pid: set(range(12)))
    twin = main.cpu_twin(_gpu_config(volume, threads=4))
    assert twin.threads == 12


def test_the_twin_thread_count_can_be_set_outright(volume, monkeypatch):
    monkeypatch.setenv("LLM_CPU_THREADS", "10")
    assert main.cpu_twin(_gpu_config(volume, threads=4)).threads == 10


def test_a_zero_twin_thread_count_lets_llama_cpp_choose(volume, monkeypatch):
    monkeypatch.setenv("LLM_CPU_THREADS", "0")
    assert main.cpu_twin(_gpu_config(volume, threads=4)).threads == 0


def test_an_unusable_twin_thread_count_falls_back_to_the_cpuset(volume, monkeypatch):
    monkeypatch.setattr(main.os, "sched_getaffinity", lambda pid: set(range(6)))
    for bad in ("ten", "-2"):
        monkeypatch.setenv("LLM_CPU_THREADS", bad)
        assert main.cpu_twin(_gpu_config(volume, threads=4)).threads == 6


# ─── lend ──────────────────────────────────────────────────────────────────────


def test_lend_swaps_to_the_twin_without_persisting_it(client, volume, monkeypatch):
    gpu = _run_gpu(volume, monkeypatch)
    loaded: list[tuple[int, str]] = []
    monkeypatch.setattr(main, "_load_llm", lambda: loaded.append((main.LLM_GPU_LAYERS, main.LLM_ACCELERATOR)))

    resp = client.post("/gpu/lend")
    assert resp.status_code == 202
    assert resp.json()["status"] == "accepted"
    assert resp.json()["lease"]["active"] is True

    body = _wait(client)
    assert body["reload"]["state"] == "ready"
    assert loaded == [(0, "cpu")]
    assert body["config"]["source"] == "lease"
    assert body["config"]["label"] == "Gemma 4 GPU (CPU)"
    assert body["config"]["gpu_layers"] == 0
    assert body["lease"] == {
        "active": True,
        "since": body["lease"]["since"],
        "previous_label": "Gemma 4 GPU",
        "previous_source": "file",
        "embedder_device": "cpu",
    }
    # A restart in the night boots on the GPU configuration the admin chose.
    assert load_active(volume) == gpu


def test_lend_moves_the_embedder_off_the_card_and_return_brings_it_back(client, volume, monkeypatch):
    _run_gpu(volume, monkeypatch)
    monkeypatch.setattr(main, "_load_llm", lambda: None)
    embedder = FakeEmbedder()
    main._state["embedder"] = embedder
    main._state["embedder_device"] = "cuda"

    client.post("/gpu/lend")
    body = _wait(client)
    assert embedder.devices == ["cpu"]
    assert body["lease"]["embedder_device"] == "cuda"
    assert client.get("/healthz", headers={}).json()["embedder_device"] == "cpu"

    client.post("/gpu/return")
    body = _wait(client)
    assert embedder.devices == ["cpu", "cuda"]
    assert body["lease"]["active"] is False
    assert client.get("/healthz", headers={}).json()["embedder_device"] == "cuda"


def test_lend_is_idempotent(client, volume, monkeypatch):
    _run_gpu(volume, monkeypatch)
    loads: list[None] = []
    monkeypatch.setattr(main, "_load_llm", lambda: loads.append(None))

    client.post("/gpu/lend")
    _wait(client)
    resp = client.post("/gpu/lend")
    assert resp.status_code == 202
    assert resp.json()["status"] == "already_lent"
    assert loads == [None]


def test_lend_on_a_cpu_configuration_loads_nothing(client, volume, monkeypatch):
    """Nothing on the card: a lease still starts (so the job's bookkeeping is
    the same every night) but no model is reloaded for it."""

    _run_gpu(volume, monkeypatch, gpu_layers=0, n_cpu_moe=0, accelerator="cpu")
    loads: list[None] = []
    monkeypatch.setattr(main, "_load_llm", lambda: loads.append(None))

    client.post("/gpu/lend")
    body = _wait(client)
    assert body["reload"]["state"] == "ready"
    assert body["lease"]["active"] is True
    assert loads == []
    assert body["config"]["source"] == "file"

    client.post("/gpu/return")
    body = _wait(client)
    assert body["lease"]["active"] is False
    assert loads == []


def test_a_failed_lend_restores_the_card_and_ends_the_lease(client, volume, monkeypatch):
    gpu = _run_gpu(volume, monkeypatch)
    embedder = FakeEmbedder()
    main._state["embedder"] = embedder
    main._state["embedder_device"] = "cuda"
    attempts: list[int] = []

    def flaky_load():
        attempts.append(main.LLM_GPU_LAYERS)
        if main.LLM_GPU_LAYERS == 0:
            raise RuntimeError("not enough RAM for the experts")

    monkeypatch.setattr(main, "_load_llm", flaky_load)

    client.post("/gpu/lend")
    body = _wait(client)
    assert body["reload"]["state"] == "error"
    assert "not enough RAM" in body["reload"]["detail"]
    assert attempts == [0, 99]
    assert body["lease"]["active"] is False
    assert body["config"]["source"] == "file"
    assert main._state["config"] == gpu
    assert embedder.devices == ["cpu", "cuda"]


def test_lend_is_refused_while_a_reload_or_download_runs(client, volume, monkeypatch):
    _run_gpu(volume, monkeypatch)
    monkeypatch.setattr(main, "_reload_running", True)
    assert client.post("/gpu/lend").status_code == 409
    monkeypatch.setattr(main, "_reload_running", False)
    monkeypatch.setattr(type(main._downloads), "busy", property(lambda self: True))
    assert client.post("/gpu/lend").status_code == 409


# ─── return ────────────────────────────────────────────────────────────────────


def test_return_reloads_the_previous_configuration(client, volume, monkeypatch):
    gpu = _run_gpu(volume, monkeypatch)
    loaded: list[int] = []
    monkeypatch.setattr(main, "_load_llm", lambda: loaded.append(main.LLM_GPU_LAYERS))

    client.post("/gpu/lend")
    _wait(client)
    resp = client.post("/gpu/return")
    assert resp.status_code == 202
    body = _wait(client)
    assert body["reload"]["state"] == "ready"
    assert loaded == [0, 99]
    assert body["lease"]["active"] is False
    assert body["config"]["source"] == "file"
    assert body["config"]["label"] == "Gemma 4 GPU"
    assert main._state["config"] == gpu
    assert load_active(volume) == gpu


def test_return_without_a_lease_is_a_noop(client, volume, monkeypatch):
    _run_gpu(volume, monkeypatch)
    loads: list[None] = []
    monkeypatch.setattr(main, "_load_llm", lambda: loads.append(None))
    resp = client.post("/gpu/return")
    assert resp.status_code == 202
    assert resp.json()["status"] == "not_lent"
    assert loads == []


def test_a_failed_return_keeps_the_lease_so_the_job_can_retry(client, volume, monkeypatch):
    """The scorer still holding the card is the realistic failure: the GPU
    load OOMs, the twin keeps serving, and the lease says so."""

    _run_gpu(volume, monkeypatch)
    embedder = FakeEmbedder()
    main._state["embedder"] = embedder
    main._state["embedder_device"] = "cuda"
    fail_gpu = {"on": False}

    def load():
        if fail_gpu["on"] and main.LLM_GPU_LAYERS > 0:
            raise RuntimeError("CUDA out of memory")

    monkeypatch.setattr(main, "_load_llm", load)

    client.post("/gpu/lend")
    _wait(client)
    fail_gpu["on"] = True
    client.post("/gpu/return")
    body = _wait(client)
    assert body["reload"]["state"] == "error"
    assert "out of memory" in body["reload"]["detail"]
    assert body["lease"]["active"] is True
    assert body["config"]["source"] == "lease"
    assert embedder.devices == ["cpu"]

    fail_gpu["on"] = False
    client.post("/gpu/return")
    body = _wait(client)
    assert body["reload"]["state"] == "ready"
    assert body["lease"]["active"] is False
    assert embedder.devices == ["cpu", "cuda"]


# ─── an admin wins ─────────────────────────────────────────────────────────────


def test_an_admin_reload_ends_the_lease(client, volume, monkeypatch):
    _run_gpu(volume, monkeypatch)
    (volume / "other.gguf").write_bytes(b"y")
    monkeypatch.setattr(main, "_load_llm", lambda: None)

    client.post("/gpu/lend")
    _wait(client)
    row = {
        "label": "Other",
        "model_filename": "other.gguf",
        "backend": "server",
        "accelerator": "cuda",
        "gpu_layers": 99,
    }
    assert client.post("/reload", json=row).status_code == 202
    body = _wait(client)
    assert body["lease"]["active"] is False
    assert body["config"]["source"] == "file"
    assert body["config"]["label"] == "Other"
    persisted = load_active(volume)
    assert persisted is not None and persisted.label == "Other"
    # And nothing is left to return to.
    assert client.post("/gpu/return").json()["status"] == "not_lent"


def test_a_reset_ends_the_lease(client, volume, monkeypatch):
    _run_gpu(volume, monkeypatch)
    monkeypatch.setattr(main, "_load_llm", lambda: None)
    monkeypatch.setattr(main, "_ensure_model_present", lambda cfg: None)

    client.post("/gpu/lend")
    _wait(client)
    assert client.post("/config/reset").status_code == 202
    body = _wait(client)
    assert body["lease"]["active"] is False
    assert body["config"]["source"] == "env"


def test_status_reports_no_lease_by_default(client):
    body = client.get("/reload/status").json()
    assert body["lease"]["active"] is False
    assert body["lease"]["previous_label"] == ""

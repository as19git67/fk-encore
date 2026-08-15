"""The runtime model-management API: /config, /reload, /models/*.

Like test_endpoints.py these run outside the lifespan, so no real model is
ever loaded. The loader itself is stubbed where a reload has to be driven end
to end — what is under test is the state machine and the guard rails, not
llama.cpp.
"""

from __future__ import annotations

import os
import sys
import time

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import main  # noqa: E402
from llm_config import LlmConfig, load_active  # noqa: E402
from model_downloads import DownloadManager  # noqa: E402


@pytest.fixture
def client():
    return TestClient(main.app)


@pytest.fixture
def volume(tmp_path, monkeypatch):
    """Point the service at a throwaway models directory."""

    monkeypatch.setattr(main, "MODELS_DIR", tmp_path)
    monkeypatch.setattr(main, "_downloads", DownloadManager(tmp_path))
    return tmp_path


@pytest.fixture(autouse=True)
def _reset_reload_state():
    original = dict(main._reload_status)
    yield
    main._reload_status.clear()
    main._reload_status.update(original)
    main._reload_running = False


def _row(**overrides) -> dict:
    """A row of llm_model_config as the app would send it."""

    return {
        "label": "Test model",
        "model_filename": "test.gguf",
        "backend": "inproc",
        "accelerator": "cpu",
        "ctx_size": 4096,
        "gpu_layers": 0,
        "batch_size": 512,
        "ubatch_size": 512,
        "flash_attn": False,
        "kv_type": "f16",
        "n_cpu_moe": 0,
        **overrides,
    }


def _wait_for_reload(client, timeout: float = 10.0) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        body = client.get("/reload/status").json()
        if body["reload"]["state"] in {"ready", "error", "idle"}:
            return body
        time.sleep(0.02)
    raise AssertionError("reload did not settle")


# ─── /healthz and /config ──────────────────────────────────────────────────────


def test_healthz_says_the_config_came_from_the_environment(client):
    """The state every deployment that has never used the admin UI is in."""

    body = client.get("/healthz").json()
    assert body["llm_config_source"] == "env"
    assert body["llm_config_label"] is None
    assert body["llm_reload_state"] == "idle"


def test_config_reports_the_live_values(client):
    body = client.get("/config").json()
    assert body["config"]["model_filename"] == main.LLM_MODEL_PATH.name
    assert body["config"]["ctx_size"] == main.LLM_CTX
    assert body["config"]["backend"] == main.LLM_BACKEND
    assert body["config"]["source"] == "env"
    assert body["reload"]["state"] == "idle"


# ─── /models/files ─────────────────────────────────────────────────────────────


def test_files_lists_the_volume_and_marks_the_loaded_model(client, volume):
    (volume / "test.gguf").write_bytes(b"x" * 20)
    monkey = main.LLM_MODEL_PATH
    try:
        main.LLM_MODEL_PATH = volume / "test.gguf"
        body = client.get("/models/files").json()
    finally:
        main.LLM_MODEL_PATH = monkey

    assert [f["filename"] for f in body["files"]] == ["test.gguf"]
    assert body["active_filename"] == "test.gguf"
    assert body["disk"]["free_bytes"] > 0


def test_the_loaded_model_cannot_be_deleted(client, volume):
    """Deleting the weights out from under a running llama.cpp is not a
    recoverable state."""

    resp = client.delete(f"/models/files/{main.LLM_MODEL_PATH.name}")
    assert resp.status_code == 409


def test_deleting_a_missing_file_is_a_404(client, volume):
    assert client.delete("/models/files/absent.gguf").status_code == 404


def test_deleting_something_that_is_not_a_bare_name_is_rejected(client, volume):
    resp = client.delete("/models/files/..%2Fescape.gguf")
    assert resp.status_code in {404, 422}


def test_delete_removes_the_file(client, volume):
    (volume / "old.gguf").write_bytes(b"x" * 20)
    assert client.delete("/models/files/old.gguf").status_code == 200
    assert not (volume / "old.gguf").exists()


# ─── /models/download ──────────────────────────────────────────────────────────


def test_a_non_http_download_url_is_rejected(client, volume):
    resp = client.post("/models/download", json={"url": "file:///etc/passwd"})
    assert resp.status_code == 422


def test_download_status_is_idle_to_begin_with(client, volume):
    assert client.get("/models/download/status").json()["download"]["state"] == "idle"


def test_cancelling_nothing_reports_false(client, volume):
    assert client.post("/models/download/cancel").json()["cancelled"] is False


# ─── /reload validation ────────────────────────────────────────────────────────


def test_reload_rejects_a_config_it_cannot_satisfy(client, volume):
    """No file on the volume and no URL to fetch it from — nothing to load."""

    resp = client.post("/reload", json=_row())
    assert resp.status_code == 422
    assert "not on the models volume" in resp.json()["detail"]


def test_reload_rejects_an_invalid_value(client, volume):
    (volume / "test.gguf").write_bytes(b"x")
    resp = client.post("/reload", json=_row(kv_type="q3_k"))
    assert resp.status_code == 422


def test_reload_rejects_a_path_as_a_filename(client, volume):
    resp = client.post("/reload", json=_row(model_filename="../../etc/passwd"))
    assert resp.status_code == 422


def test_reload_requires_a_filename(client, volume):
    body = _row()
    del body["model_filename"]
    assert client.post("/reload", json=body).status_code == 422


def test_the_server_backend_is_refused_without_a_llama_server(client, volume, monkeypatch):
    """Loading it in-process instead would silently ignore the very flags the
    server backend was chosen for."""

    (volume / "test.gguf").write_bytes(b"x")
    monkeypatch.setattr(type(main._llama_server), "available", property(lambda self: False))

    resp = client.post("/reload", json=_row(backend="server"))
    assert resp.status_code == 422
    assert "llama-server" in resp.json()["detail"]


def test_a_reload_is_refused_while_a_download_runs(client, volume, monkeypatch):
    (volume / "test.gguf").write_bytes(b"x")
    monkeypatch.setattr(type(main._downloads), "busy", property(lambda self: True))
    assert client.post("/reload", json=_row()).status_code == 409


def test_a_second_reload_is_refused(client, volume, monkeypatch):
    (volume / "test.gguf").write_bytes(b"x")
    monkeypatch.setattr(main, "_reload_running", True)
    assert client.post("/reload", json=_row()).status_code == 409


# ─── /reload behaviour ─────────────────────────────────────────────────────────


def test_a_successful_reload_applies_and_persists_the_config(client, volume, monkeypatch):
    (volume / "test.gguf").write_bytes(b"x")
    loaded: list[str] = []
    monkeypatch.setattr(main, "_load_llm", lambda: loaded.append(main.LLM_MODEL_PATH.name))

    assert client.post("/reload", json=_row(ctx_size=4096)).status_code == 202
    body = _wait_for_reload(client)

    assert body["reload"]["state"] == "ready"
    assert loaded == ["test.gguf"]
    assert main.LLM_CTX == 4096
    assert main.LLM_MODEL_PATH == volume / "test.gguf"

    # Persisted only after a successful load, so a restart comes back here.
    persisted = load_active(volume)
    assert persisted is not None
    assert persisted.label == "Test model"
    assert persisted.ctx == 4096


def test_a_failed_reload_rolls_back_and_persists_nothing(client, volume, monkeypatch):
    """A typo'd filename or a model this build cannot read must not cost an
    outage, and must not become the config the container boots into."""

    (volume / "test.gguf").write_bytes(b"x")
    before = main._state["config"]
    attempts: list[str] = []

    def flaky_load():
        attempts.append(main.LLM_MODEL_PATH.name)
        if main.LLM_MODEL_PATH.name == "test.gguf":
            raise RuntimeError("unsupported architecture")

    monkeypatch.setattr(main, "_load_llm", flaky_load)

    assert client.post("/reload", json=_row()).status_code == 202
    body = _wait_for_reload(client)

    assert body["reload"]["state"] == "error"
    assert "unsupported architecture" in body["reload"]["detail"]
    # Rolled back onto the config that was working.
    assert main._state["config"] == before
    assert attempts == ["test.gguf", before.model_path.name]
    assert load_active(volume) is None


def test_reload_clears_the_model_so_callers_get_a_503(client, volume, monkeypatch):
    """The app's llm-client already treats 503 as "defer and retry later", so
    this is all the coordination a model swap needs."""

    (volume / "test.gguf").write_bytes(b"x")
    main._state["llm"] = object()
    seen: list[object] = []

    def check_cleared():
        seen.append(main._state["llm"])

    monkeypatch.setattr(main, "_load_llm", check_cleared)

    client.post("/reload", json=_row())
    _wait_for_reload(client)

    assert seen == [None]


def test_reload_downloads_a_model_that_is_not_on_the_volume(client, volume, monkeypatch):
    fetched: list[tuple[str, str]] = []

    def fake_download(targets, sha256=""):
        for target in targets:
            fetched.append((target.url, target.filename))
            (volume / target.filename).write_bytes(b"weights")

    monkeypatch.setattr(main._downloads, "run_blocking", fake_download)
    monkeypatch.setattr(main, "_load_llm", lambda: None)

    resp = client.post(
        "/reload",
        json=_row(
            model_url="https://host/test.gguf",
            extra_urls=["https://host/shard-2.gguf"],
        ),
    )
    assert resp.status_code == 202
    body = _wait_for_reload(client)

    assert body["reload"]["state"] == "ready"
    assert fetched == [
        ("https://host/test.gguf", "test.gguf"),
        ("https://host/shard-2.gguf", "shard-2.gguf"),
    ]


# ─── /config/reset ─────────────────────────────────────────────────────────────


def test_reset_removes_the_file_and_returns_to_the_environment(client, volume, monkeypatch):
    """The way out if an activated configuration turns out to be wrong."""

    activated = LlmConfig.from_dict(_row(ctx_size=4096), models_dir=volume)
    main._apply_config(activated, source="file")
    from llm_config import save_active

    save_active(volume, activated)
    monkeypatch.setattr(main, "_load_llm", lambda: None)
    monkeypatch.setattr(main, "_ensure_model_present", lambda cfg: None)

    resp = client.post("/config/reset")
    assert resp.status_code == 202
    assert resp.json()["removed_file"] is True

    body = _wait_for_reload(client)
    assert body["reload"]["state"] == "ready"
    assert body["config"]["source"] == "env"
    assert main._state["config"] == main._BOOT_CONFIG
    assert load_active(volume) is None


def test_reset_is_refused_during_a_reload(client, volume, monkeypatch):
    monkeypatch.setattr(main, "_reload_running", True)
    assert client.post("/config/reset").status_code == 409


# ─── Startup precedence ────────────────────────────────────────────────────────


def test_startup_uses_the_environment_when_nothing_is_activated(volume):
    """The guarantee for every deployment that never touches the admin UI."""

    cfg, source = main._resolve_startup_config()
    assert source == "env"
    assert cfg == main._BOOT_CONFIG


def test_startup_prefers_an_activated_configuration(volume):
    from llm_config import save_active

    activated = LlmConfig.from_dict(_row(label="Activated", ctx_size=4096), models_dir=volume)
    save_active(volume, activated)

    cfg, source = main._resolve_startup_config()
    assert source == "file"
    assert cfg.label == "Activated"
    assert cfg.ctx == 4096


def test_a_corrupt_activated_configuration_falls_back_instead_of_crash_looping(volume):
    """Every endpoint lives behind this startup, so a config the service
    refuses to parse would be unrepairable over HTTP."""

    (volume / ".active_config.json").write_text("{ broken", encoding="utf-8")

    cfg, source = main._resolve_startup_config()
    assert source == "env"
    assert cfg == main._BOOT_CONFIG

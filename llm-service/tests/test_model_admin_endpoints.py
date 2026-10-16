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
    # No projector on the test volume: the app's model page says "nur Text".
    assert body["config"]["vision"] is False


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


# ─── crash-vs-reload race ───────────────────────────────────────────────────────
#
# A llama-server that dies is normally fatal on purpose (see
# llama_supervisor.terminate_own_process) — but not while a reload is in
# progress, where the crash is exactly what _reload_worker's except block
# exists to recover from. Killing the process here as well would win that
# race every time: the watcher notices within milliseconds, long before a
# rollback to the previous configuration could even start.


def test_a_crash_during_reload_does_not_kill_the_service(monkeypatch):
    killed = []
    monkeypatch.setattr(main, "terminate_own_process", lambda status: killed.append(status))
    monkeypatch.setattr(main, "_reload_running", True)

    main._handle_unexpected_exit(-6)

    assert killed == []


def test_a_crash_outside_a_reload_still_kills_the_service(monkeypatch):
    killed = []
    monkeypatch.setattr(main, "terminate_own_process", lambda status: killed.append(status))
    monkeypatch.setattr(main, "_reload_running", False)

    main._handle_unexpected_exit(-6)

    assert killed == [-6]


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


# ─── inproc in an image without llama-cpp-python ───────────────────────────────


def test_an_inproc_config_runs_in_llama_server_on_the_cpu_when_the_image_lacks_llama_cpp(client, volume, monkeypatch):
    """The GPU image ships llama-server but not llama-cpp-python. A CPU model
    configured for `inproc` used to fail there and fall back to the previous
    model; llama-server runs it instead, with nothing offloaded."""

    (volume / "test.gguf").write_bytes(b"x")
    monkeypatch.setattr(main, "_inproc_available", lambda: False)
    monkeypatch.setattr(type(main._llama_server), "available", property(lambda self: True))
    loaded: list[tuple[str, int]] = []
    monkeypatch.setattr(main, "_load_llm", lambda: loaded.append((main.LLM_BACKEND, main.LLM_GPU_LAYERS)))

    assert client.post("/reload", json=_row(backend="inproc", gpu_layers=20, n_cpu_moe=4)).status_code == 202
    body = _wait_for_reload(client)

    assert body["reload"]["state"] == "ready"
    assert loaded == [("server", 0)]
    assert body["config"]["backend"] == "server"
    assert "llama-server on the CPU" in body["config"]["notice"]
    assert body["backends"] == {"inproc": False, "server": True}


def test_an_inproc_config_is_left_alone_where_llama_cpp_is_installed(client, volume, monkeypatch):
    (volume / "test.gguf").write_bytes(b"x")
    monkeypatch.setattr(main, "_inproc_available", lambda: True)
    monkeypatch.setattr(type(main._llama_server), "available", property(lambda self: True))
    loaded: list[str] = []
    monkeypatch.setattr(main, "_load_llm", lambda: loaded.append(main.LLM_BACKEND))

    assert client.post("/reload", json=_row(backend="inproc")).status_code == 202
    body = _wait_for_reload(client)

    assert loaded == ["inproc"]
    assert body["config"]["notice"] is None


def test_a_failed_rerouted_reload_does_not_leave_its_notice_behind(client, volume, monkeypatch):
    (volume / "test.gguf").write_bytes(b"x")
    monkeypatch.setattr(main, "_inproc_available", lambda: False)
    monkeypatch.setattr(type(main._llama_server), "available", property(lambda self: True))
    calls = {"n": 0}

    def flaky_load():
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("cannot read this model")

    monkeypatch.setattr(main, "_load_llm", flaky_load)
    assert client.post("/reload", json=_row(backend="inproc")).status_code == 202
    body = _wait_for_reload(client)

    assert body["reload"]["state"] == "error"
    assert body["config"]["notice"] is None


def test_a_projector_that_stops_llama_server_is_dropped_and_the_model_runs_text_only(volume, monkeypatch):
    """Rather than rolling back to the previous model, the model loads without
    image understanding, and the status says so."""

    import llama_server

    (volume / "test.gguf").write_bytes(b"x")
    (volume / "mmproj-F16.gguf").write_bytes(b"x")
    starts: list[str] = []

    class FakeSupervisor:
        available = True
        is_running = False
        binary = "llama-server"

        def start(self, cfg):
            starts.append(cfg.resolve_mmproj())
            self.is_running = True

        def stop(self):
            self.is_running = False

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        def wait_until_ready(self, timeout, still_starting=None):
            if main._state["config"].resolve_mmproj():
                raise RuntimeError("llama-server exited during startup")
            return {"model_path": "test.gguf"}

    monkeypatch.setattr(main, "_llama_server", FakeSupervisor())
    monkeypatch.setattr(llama_server, "LlamaServerClient", FakeClient)
    cfg = LlmConfig(model_path=volume / "test.gguf", backend="server")
    main._apply_config(cfg, source="file")
    try:
        main._load_server_llm()
        assert starts == [str(volume / "mmproj-F16.gguf"), ""]
        assert main._state["llm"] is not None
        assert "without image understanding" in main._state["backend_notice"]
    finally:
        main._state["llm"] = None
        main._apply_config(main._BOOT_CONFIG, source="env")


def test_a_crash_while_loading_is_reported_by_its_exit_status(volume, monkeypatch):
    """"GET /props -> HTTP 503 Loading model" was the last thing the poll
    saw, not why the process died; the status is, and -9 is the OOM killer."""

    import llama_server

    (volume / "test.gguf").write_bytes(b"x")

    class FakeSupervisor:
        available = True
        is_running = False
        last_exit_status = None
        binary = "llama-server"

        def start(self, cfg):
            self.is_running = False
            self.last_exit_status = -9

        def stop(self):
            self.is_running = False

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        def wait_until_ready(self, timeout, still_starting=None):
            raise llama_server.LlamaServerError("llama-server exited before becoming ready: GET /props -> HTTP 503 Loading model")

    monkeypatch.setattr(main, "_llama_server", FakeSupervisor())
    monkeypatch.setattr(llama_server, "LlamaServerClient", FakeClient)
    main._apply_config(LlmConfig(model_path=volume / "test.gguf", backend="server"), source="file")
    try:
        with pytest.raises(llama_server.LlamaServerError) as excinfo:
            main._load_server_llm()
        message = str(excinfo.value)
        assert "exited with status -9 while loading test.gguf" in message
        assert "OOM killer" in message
        assert "503" not in message
    finally:
        main._state["llm"] = None
        main._apply_config(main._BOOT_CONFIG, source="env")


# ─── Loading at boot ───────────────────────────────────────────────────────────


def test_a_crash_while_a_model_loads_does_not_kill_the_service(monkeypatch):
    """At boot the kill arrived as SIGTERM during startup: the service came up
    text-only after the retry and shut down the moment it was ready, and
    compose started it again — a loop no endpoint could break."""

    killed = []
    monkeypatch.setattr(main, "terminate_own_process", lambda status: killed.append(status))
    monkeypatch.setattr(main, "_reload_running", False)
    monkeypatch.setattr(main, "_llm_loading", True)

    main._handle_unexpected_exit(-6)

    assert killed == []


def test_loading_sets_the_flag_only_while_it_runs(monkeypatch):
    seen = []

    def load():
        seen.append(main._llm_loading)
        raise RuntimeError("no")

    monkeypatch.setattr(main, "_load_server_llm", load)
    monkeypatch.setattr(main, "_load_inproc_llm", load)
    with pytest.raises(RuntimeError):
        main._load_llm()
    assert seen == [True]
    assert main._llm_loading is False


def test_an_activated_configuration_that_fails_at_boot_yields_to_the_environment(volume, monkeypatch):
    """The persisted file is only rewritten by a successful reload, and a
    reload needs the service up — so the service must come up."""

    (volume / "test.gguf").write_bytes(b"x")
    loads: list[str] = []

    def load():
        loads.append(main._state["config"].model_path.name)
        if len(loads) == 1:
            raise RuntimeError("llama-server exited with status 1 while loading test.gguf")

    monkeypatch.setattr(main, "_load_llm", load)
    monkeypatch.setattr(main, "_ensure_model_present", lambda cfg: None)
    main._apply_config(LlmConfig(model_path=volume / "test.gguf", backend="inproc", label="Broken"), source="file")
    try:
        main._load_llm_at_boot("file")
        assert loads == ["test.gguf", main._BOOT_CONFIG.model_path.name]
        assert main._state["config_source"] == "env"
        assert main._reload_status["state"] == "error"
        assert "'Broken' did not load at startup" in main._reload_status["detail"]
        assert main._BOOT_CONFIG.model_path.name in main._reload_status["detail"]
    finally:
        main._apply_config(main._BOOT_CONFIG, source="env")


def test_the_environment_configuration_failing_at_boot_is_still_fatal(monkeypatch):
    def load():
        raise RuntimeError("no")

    monkeypatch.setattr(main, "_load_llm", load)
    with pytest.raises(RuntimeError):
        main._load_llm_at_boot("env")


def test_a_reload_persists_what_loaded_not_what_was_asked_for(client, volume, monkeypatch):
    """A model that went up without its projector boots without it too,
    instead of failing on the projector again at every start."""

    import dataclasses

    (volume / "test.gguf").write_bytes(b"x")
    monkeypatch.setattr(main, "_inproc_available", lambda: True)

    def load():
        main._state["config"] = dataclasses.replace(main._state["config"], vision=False)

    monkeypatch.setattr(main, "_load_llm", load)
    try:
        assert client.post("/reload", json=_row(backend="inproc")).status_code == 202
        body = _wait_for_reload(client)
        assert body["reload"]["state"] == "ready"
        assert body["config"]["vision"] is False
        assert load_active(volume).vision is False
    finally:
        # vision=False must not leak into the tests that hand a projector to
        # the live configuration.
        main._apply_config(main._BOOT_CONFIG, source="env")

"""The service's state machine and scoring endpoint, with a fake scorer.

The real scorer needs torch, bitsandbytes and a GPU; none of that is
available where these run. What the service owes its caller — the nightly
job in the app — is the contract: no scoring before a load, a load that
reports its progress and its failure, a clean unload, and a score shaped
the way the photo service reads it. That is what these pin.
"""

from __future__ import annotations

import io
import threading
import time

import pytest
from PIL import Image
from starlette.testclient import TestClient

import main
from scorer import Scores, ScorerError


class FakeScorer:
    model_id = "fake/one-align"
    version = "qalign_test"

    def __init__(self, *, fail_load: bool = False, aesthetics: float = 3.7, quality: float = 4.1):
        self.fail_load = fail_load
        self.aesthetics = aesthetics
        self.quality = quality
        self.loaded = False
        self.unload_calls = 0
        self.seen_sizes: list[tuple[int, int]] = []
        # Lets a test hold a load open to observe the "loading" state.
        self.gate = threading.Event()
        self.gate.set()

    def load(self) -> None:
        self.gate.wait(timeout=5)
        if self.fail_load:
            raise RuntimeError("no CUDA device")
        self.loaded = True

    def unload(self) -> None:
        self.unload_calls += 1
        self.loaded = False

    def score(self, image) -> Scores:
        if not self.loaded:
            raise ScorerError("model not loaded")
        self.seen_sizes.append(image.size)
        return Scores(aesthetics=self.aesthetics, quality=self.quality)

    def vram_used_bytes(self):
        return 1234 if self.loaded else None


@pytest.fixture
def fake(monkeypatch):
    scorer = FakeScorer()
    monkeypatch.setattr(main, "_scorer", None)
    monkeypatch.setattr(main, "_scorer_factory", lambda: scorer)
    monkeypatch.setattr(main, "_state", main._State())
    return scorer


@pytest.fixture
def client(fake):
    with TestClient(main.app) as c:
        yield c


def _png(width: int = 64, height: int = 48) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (width, height), (120, 80, 40)).save(buf, format="PNG")
    return buf.getvalue()


def _wait_for(client: TestClient, state: str, timeout: float = 5.0) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        body = client.get("/status").json()
        if body["state"] == state:
            return body
        time.sleep(0.02)
    raise AssertionError(f"state never became {state!r}: {body}")


def test_starts_unloaded_and_health_is_open(client):
    assert client.get("/healthz", headers={}).json() == {"status": "ok", "state": "unloaded"}
    body = client.get("/status").json()
    assert body["state"] == "unloaded"
    assert body["error"] is None
    assert body["scored"] == 0


def test_refuses_to_score_until_loaded(client):
    resp = client.post("/score", files={"file": ("p.png", _png(), "image/png")})
    assert resp.status_code == 503
    assert "POST /load" in resp.json()["detail"]


def test_load_then_score_then_unload(client, fake):
    resp = client.post("/load")
    assert resp.status_code == 202
    body = _wait_for(client, "loaded")
    assert body["loaded_at"] is not None
    assert body["vram_used_bytes"] == 1234
    assert body["model_id"] == "fake/one-align"

    resp = client.post("/score", files={"file": ("p.png", _png(), "image/png")})
    assert resp.status_code == 200
    body = resp.json()
    assert body["aesthetics"] == 3.7
    assert body["quality"] == 4.1
    assert body["scale"] == {"min": 1.0, "max": 5.0}
    assert body["version"] == "qalign_test"
    assert body["elapsed_ms"] >= 0
    assert client.get("/status").json()["scored"] == 1

    resp = client.post("/unload")
    assert resp.status_code == 202
    body = _wait_for(client, "unloaded")
    assert body["loaded_at"] is None
    assert fake.unload_calls == 1

    # Back to the daytime condition: scoring refused, nothing resident.
    resp = client.post("/score", files={"file": ("p.png", _png(), "image/png")})
    assert resp.status_code == 503


def test_load_is_idempotent_and_unload_without_model_is_a_noop(client, fake):
    client.post("/load")
    _wait_for(client, "loaded")
    # A second /load on a loaded scorer answers at once and loads nothing.
    assert client.post("/load").status_code == 202
    assert client.get("/status").json()["state"] == "loaded"
    client.post("/unload")
    _wait_for(client, "unloaded")
    assert client.post("/unload").status_code == 202
    assert fake.unload_calls == 1


def test_conflicting_lifecycle_calls_while_loading(client, fake):
    fake.gate.clear()
    client.post("/load")
    assert client.get("/status").json()["state"] == "loading"
    assert client.post("/load").status_code == 409
    assert client.post("/unload").status_code == 409
    assert client.post("/score", files={"file": ("p.png", _png(), "image/png")}).status_code == 503
    fake.gate.set()
    _wait_for(client, "loaded")


def test_failed_load_reports_the_error_and_leaves_nothing_behind(monkeypatch):
    scorer = FakeScorer(fail_load=True)
    monkeypatch.setattr(main, "_scorer", None)
    monkeypatch.setattr(main, "_scorer_factory", lambda: scorer)
    monkeypatch.setattr(main, "_state", main._State())
    with TestClient(main.app) as client:
        client.post("/load")
        body = _wait_for(client, "error")
        assert "no CUDA device" in body["error"]
        # The failed load is cleaned up so the card holds nothing of it.
        assert scorer.unload_calls == 1
        # From error, both a retry and an unload are allowed.
        assert client.post("/unload").status_code == 202
        body = _wait_for(client, "unloaded")
        assert body["error"] is None


def test_rejects_an_unreadable_image(client, fake):
    client.post("/load")
    _wait_for(client, "loaded")
    resp = client.post("/score", files={"file": ("p.png", b"not an image", "image/png")})
    assert resp.status_code == 422


def test_large_images_are_downscaled_before_scoring(client, fake, monkeypatch):
    monkeypatch.setattr(main, "MAX_EDGE", 100)
    client.post("/load")
    _wait_for(client, "loaded")
    client.post("/score", files={"file": ("p.png", _png(400, 200), "image/png")})
    assert fake.seen_sizes == [(100, 50)]

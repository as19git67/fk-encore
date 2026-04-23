"""HTTP-level tests that run without loading the real models.

The FastAPI lifespan only executes inside a TestClient context manager —
outside of it, the module-level ``_state`` stays at its ``None`` defaults,
which is exactly what the "not ready yet" code paths check. That lets us
exercise the error branches without needing llama-cpp or sentence-transformers
to actually open a model.
"""

from __future__ import annotations

import asyncio
import os
import sys
import threading
import time

import httpx
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import main  # noqa: E402


def test_healthz_reports_starting_before_models_load():
    # Ensure we start from an unloaded state — other tests in the same
    # process might have mutated it.
    main._state["llm"] = None
    main._state["embedder"] = None

    client = TestClient(main.app)
    resp = client.get("/healthz")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "starting"
    assert body["llm_loaded"] is False
    assert body["embedder_loaded"] is False
    assert body["embedding_model"] == main.EMBEDDING_MODEL


def test_healthz_reports_ok_when_both_models_present():
    main._state["llm"] = object()
    main._state["embedder"] = object()
    try:
        client = TestClient(main.app)
        body = client.get("/healthz").json()
        assert body["status"] == "ok"
        assert body["llm_loaded"] is True
        assert body["embedder_loaded"] is True
    finally:
        main._state["llm"] = None
        main._state["embedder"] = None


def test_embed_returns_503_when_embedder_missing():
    main._state["embedder"] = None
    client = TestClient(main.app)
    resp = client.post("/embed", json={"texts": ["hallo"]})
    assert resp.status_code == 503
    assert "embedder" in resp.json()["detail"].lower()


def test_embed_validates_empty_list():
    client = TestClient(main.app)
    resp = client.post("/embed", json={"texts": []})
    assert resp.status_code == 422


def test_classify_returns_503_when_llm_missing():
    main._state["llm"] = None
    client = TestClient(main.app)
    resp = client.post(
        "/classify",
        json={
            "text": "Stromrechnung Januar",
            "taxonomy": [{"slug": "finanzen", "name": "Finanzen"}],
        },
    )
    assert resp.status_code == 503
    assert "llm" in resp.json()["detail"].lower()


def test_classify_validates_empty_text():
    client = TestClient(main.app)
    resp = client.post(
        "/classify",
        json={
            "text": "",
            "taxonomy": [{"slug": "finanzen", "name": "Finanzen"}],
        },
    )
    assert resp.status_code == 422


def test_classify_validates_empty_taxonomy():
    client = TestClient(main.app)
    resp = client.post(
        "/classify",
        json={"text": "x", "taxonomy": []},
    )
    assert resp.status_code == 422


def test_recap_title_returns_503_when_llm_missing():
    main._state["llm"] = None
    client = TestClient(main.app)
    resp = client.post(
        "/recap-title",
        json={"kind": "trip", "place_city": "Lissabon"},
    )
    assert resp.status_code == 503
    assert "llm" in resp.json()["detail"].lower()


def test_recap_title_validates_missing_kind():
    client = TestClient(main.app)
    resp = client.post("/recap-title", json={})
    assert resp.status_code == 422


def test_recap_context_renders_expected_lines():
    req = main.RecapTitleRequest(
        kind="trip",
        place_city="Lissabon",
        place_country="Portugal",
        date_range="Juli 2023",
        photo_count=42,
        keywords=["strand", "meer", "altstadt"],
    )
    ctx = main._recap_context(req)
    assert "Art des Rückblicks: trip" in ctx
    assert "Ort: Lissabon" in ctx
    assert "Land: Portugal" in ctx
    assert "Zeitraum: Juli 2023" in ctx
    assert "Fotos: 42" in ctx
    assert "Stichwörter: strand, meer, altstadt" in ctx


def test_recap_context_skips_country_when_equal_to_city():
    req = main.RecapTitleRequest(
        kind="place", place_city="Berlin", place_country="Berlin"
    )
    ctx = main._recap_context(req)
    assert "Ort: Berlin" in ctx
    assert "Land: Berlin" not in ctx


def test_healthz_stays_responsive_while_classify_is_blocked():
    """Regression: before /classify was moved to a background thread, a long
    llama.cpp call blocked the event loop for its full duration and the
    compose healthcheck (``curl /healthz``, 10 s timeout) flipped the
    container to "unhealthy" under load, which then made ``docker compose
    up -d`` refuse to start dependent services.

    We simulate a long-running inference with a ``time.sleep`` stub and
    assert that ``/healthz`` still answers promptly while it's in flight.
    """

    started = threading.Event()
    release = threading.Event()

    class _BlockingLlm:
        def create_chat_completion(self, **_kwargs):
            started.set()
            # Wait for the test to let us go. If the event loop is
            # blocked by this call, /healthz cannot answer until after
            # release.set() runs.
            release.wait(timeout=5)
            return {
                "choices": [
                    {"message": {"content": '{"category_slug":"x","title":"t",'
                                             '"summary":"s","tags":[],'
                                             '"confidence":0.5}'}}
                ]
            }

    main._state["llm"] = _BlockingLlm()
    main._state["embedder"] = object()
    try:
        async def _run():
            transport = httpx.ASGITransport(app=main.app)
            async with httpx.AsyncClient(transport=transport,
                                         base_url="http://test") as client:
                classify_task = asyncio.create_task(
                    client.post(
                        "/classify",
                        json={
                            "text": "x",
                            "taxonomy": [{"slug": "x", "name": "X"}],
                        },
                        timeout=10.0,
                    )
                )
                # Wait for the classify call to reach the blocking stub —
                # at that point the executor thread is stuck inside it.
                for _ in range(50):
                    if started.is_set():
                        break
                    await asyncio.sleep(0.02)
                assert started.is_set(), "classify stub never ran"

                t0 = time.monotonic()
                health = await client.get("/healthz", timeout=2.0)
                elapsed = time.monotonic() - t0
                assert health.status_code == 200
                # Generously bounded; the point is < 5 s (the release
                # timeout), which proves the loop isn't blocked.
                assert elapsed < 1.0, f"/healthz took {elapsed:.2f}s while classify was running"

                release.set()
                await classify_task

        asyncio.run(_run())
    finally:
        release.set()
        main._state["llm"] = None
        main._state["embedder"] = None

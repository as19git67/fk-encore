"""HTTP-level tests that run without loading the real models.

The FastAPI lifespan only executes inside a TestClient context manager —
outside of it, the module-level ``_state`` stays at its ``None`` defaults,
which is exactly what the "not ready yet" code paths check. That lets us
exercise the error branches without needing llama-cpp or sentence-transformers
to actually open a model.
"""

from __future__ import annotations

import os
import sys

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

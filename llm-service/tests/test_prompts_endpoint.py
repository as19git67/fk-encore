"""Tests for the lazy prompt-push flow.

``main._CLASSIFY_PROMPTS`` starts unset (``None``); the llm-service is meant
to come up without prompts baked into the Docker image so a prompt-only
change no longer requires a container rebuild (~55 min). The Encore app
pushes prompts via ``PUT /prompts`` on first use and retries after a 412 —
see ``documents/llm-client.ts``.

The ``_classify_prompts_configured`` autouse fixture in ``conftest.py`` sets
up a minimal prompt config for every other test file; the tests below
explicitly reset to the unconfigured state to exercise the gate itself.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

import main

_VALID_PROMPTS = {
    "classify_system": "SYSTEM",
    "classify_document_type": "DOCTYPE",
    "classify_tax": "TAX",
    "classify_subject_persons": "SUBJECTS",
    "classify_examples": "EXAMPLES",
}


class _StubLlm:
    def create_chat_completion(self, **_kwargs):
        return {
            "choices": [
                {
                    "message": {
                        "content": '{"category_slug":"x","title":"t",'
                        '"summary":"s","tags":[],"confidence":0.5}'
                    }
                }
            ]
        }


def test_classify_returns_412_when_prompts_not_configured():
    main._CLASSIFY_PROMPTS = None
    main._state["llm"] = _StubLlm()
    try:
        client = TestClient(main.app)
        resp = client.post(
            "/classify",
            json={
                "text": "Stromrechnung Januar",
                "taxonomy": [{"slug": "finanzen", "name": "Finanzen"}],
            },
        )
        assert resp.status_code == 412
        assert resp.json()["detail"] == "prompts_not_configured"
    finally:
        main._state["llm"] = None


def test_healthz_reports_prompts_configured_flag():
    main._CLASSIFY_PROMPTS = None
    client = TestClient(main.app)
    assert client.get("/healthz").json()["prompts_configured"] is False

    main._CLASSIFY_PROMPTS = {"system": "s", "document_type": "d", "tax": "t", "subject_persons": "p", "examples": "e"}
    assert client.get("/healthz").json()["prompts_configured"] is True


def test_put_prompts_configures_and_unblocks_classify():
    main._CLASSIFY_PROMPTS = None
    main._state["llm"] = _StubLlm()
    try:
        client = TestClient(main.app)

        # /classify 412s before prompts are pushed.
        resp = client.post(
            "/classify",
            json={"text": "x", "taxonomy": [{"slug": "finanzen", "name": "Finanzen"}]},
        )
        assert resp.status_code == 412

        put_resp = client.put("/prompts", json=_VALID_PROMPTS)
        assert put_resp.status_code == 200
        assert put_resp.json()["status"] == "ok"

        # Now /classify proceeds.
        resp = client.post(
            "/classify",
            json={"text": "x", "taxonomy": [{"slug": "finanzen", "name": "Finanzen"}]},
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["category_slug"] == "x"
    finally:
        main._state["llm"] = None


def test_put_prompts_rejects_empty_field():
    main._CLASSIFY_PROMPTS = None
    client = TestClient(main.app)
    bad = {**_VALID_PROMPTS, "classify_tax": ""}
    resp = client.put("/prompts", json=bad)
    assert resp.status_code == 422

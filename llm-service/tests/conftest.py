"""Shared pytest fixtures for the llm-service test suite.

Session-wide `sys.path` setup so every test module can `import main`
without repeating the `sys.path.insert` boilerplate.
"""

from __future__ import annotations

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# The service refuses to start without INTERNAL_SERVICE_SECRET, so give the
# tests one before anything imports the app. Set rather than defaulted, so a
# value that happens to be in the developer's shell cannot change what the
# tests exercise.
os.environ["INTERNAL_SERVICE_SECRET"] = "test-internal-secret"

# Every request now needs the bearer token. Rather than touching each
# TestClient call site, hand the client a default Authorization header —
# tests that specifically cover the auth middleware override it per request.
try:
    from starlette.testclient import TestClient as _TestClient

    if not getattr(_TestClient, "_fk_auth_default", False):
        _orig_init = _TestClient.__init__

        def _init_with_auth(self, app, *args, **kwargs):
            # Only when the caller said nothing about headers. Passing
            # headers={} explicitly is how a test opts out — which is what
            # test_service_auth.py needs to exercise the unauthorized case.
            if "headers" not in kwargs:
                kwargs["headers"] = {
                    "authorization": f"Bearer {os.environ['INTERNAL_SERVICE_SECRET']}"
                }
            _orig_init(self, app, *args, **kwargs)

        _TestClient.__init__ = _init_with_auth
        _TestClient._fk_auth_default = True
except (ImportError, RuntimeError):
    # No httpx for this service's test deps. Starlette raises RuntimeError
    # rather than ImportError for that, so both are caught. The env var above
    # is set either way; a service whose auth test needs TestClient will fail
    # loudly on the import there, which is the right noise for a security test.
    pass


import main  # noqa: E402


@pytest.fixture(autouse=True)
def _classify_prompts_configured():
    """`/classify` now 412s until `PUT /prompts` has configured
    ``main._CLASSIFY_PROMPTS`` (see the lazy prompt-push design in
    `documents/llm-client.ts`). Existing tests exercise `/classify` with a
    stubbed LLM and don't care about prompt *content*, so pre-configure a
    minimal set here and reset afterwards. Tests that specifically cover the
    412/`PUT /prompts` flow (`test_prompts_endpoint.py`) override this by
    resetting `main._CLASSIFY_PROMPTS` to ``None`` for the duration of the
    test.
    """

    main._CLASSIFY_PROMPTS = {
        "system": "SYSTEM_PROMPT",
        "document_type": "DOCUMENT_TYPE_PROMPT",
        "tax": "TAX_PROMPT",
        "subject_persons": "SUBJECT_PERSONS_PROMPT",
        "examples": "EXAMPLES_PROMPT",
    }
    yield
    main._CLASSIFY_PROMPTS = None

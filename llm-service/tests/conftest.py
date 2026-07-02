"""Shared pytest fixtures for the llm-service test suite.

Session-wide `sys.path` setup so every test module can `import main`
without repeating the `sys.path.insert` boilerplate.
"""

from __future__ import annotations

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

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
        "tax": "TAX_PROMPT",
        "subject_persons": "SUBJECT_PERSONS_PROMPT",
        "examples": "EXAMPLES_PROMPT",
    }
    yield
    main._CLASSIFY_PROMPTS = None

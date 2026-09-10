"""Test setup for the taxonomy-tools sidecar.

The sidecar and the taxonomy scripts live in different directories but run as
one unit inside the image (scripts under /app/scripts/taxonomy, main.py at
/app). These tests import both from their real locations in the repo rather
than from an assembled build context, so they run without build-context.sh.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SIDECAR_DIR = REPO_ROOT / "taxonomy-tools"
SCRIPTS_DIR = REPO_ROOT / "scripts" / "taxonomy"

for path in (SIDECAR_DIR, SCRIPTS_DIR):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

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

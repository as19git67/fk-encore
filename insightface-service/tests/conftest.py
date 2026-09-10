"""Test setup: the service now requires a shared secret to start.

See service_auth.py — INTERNAL_SERVICE_SECRET is mandatory so a
misconfigured deployment fails at boot instead of listening unprotected.
"""

from __future__ import annotations

import os

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
except ImportError:  # httpx not installed for this service's test deps
    pass

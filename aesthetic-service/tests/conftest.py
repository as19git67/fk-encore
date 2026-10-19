"""Shared pytest setup for the aesthetic-service suite.

The service refuses to start without INTERNAL_SERVICE_SECRET (see
service_auth.py), so the tests set one before anything imports the app, and
every TestClient gets the bearer header by default; test_service_auth.py
opts out per request to exercise the unauthorized case.
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ["INTERNAL_SERVICE_SECRET"] = "test-internal-secret"

try:
    from starlette.testclient import TestClient as _TestClient

    if not getattr(_TestClient, "_fk_auth_default", False):
        _orig_init = _TestClient.__init__

        def _init_with_auth(self, app, *args, **kwargs):
            if "headers" not in kwargs:
                kwargs["headers"] = {
                    "authorization": f"Bearer {os.environ['INTERNAL_SERVICE_SECRET']}"
                }
            _orig_init(self, app, *args, **kwargs)

        _TestClient.__init__ = _init_with_auth
        _TestClient._fk_auth_default = True
except (ImportError, RuntimeError):
    pass

"""
Shared-secret authentication for this service.

The service binds 0.0.0.0:8000 inside its container and has no other
authentication. In the production stack it publishes no host port, so
nothing outside the compose network can reach it — but any container that
lands on the same bridge network gets full access, which for a service that
runs models on request (and, in the case of taxonomy-tools, spawns scripts
and holds an API key) is not a boundary worth relying on alone.

So `INTERNAL_SERVICE_SECRET` is mandatory: without it the service refuses to
start rather than listen unprotected. A misconfigured deployment fails
loudly at boot instead of quietly serving anybody who can route to it.

Health endpoints stay open so the container healthcheck remains a plain
curl with no credentials to leak into the compose file.
"""

from __future__ import annotations

import hmac
import os

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

ENV_VAR = "INTERNAL_SERVICE_SECRET"

# Reachable without credentials — these are what Docker polls, and they
# report liveness only.
OPEN_PATHS = frozenset({"/health", "/healthz"})


def _expected_header() -> bytes:
    secret = os.environ.get(ENV_VAR, "").strip()
    if not secret:
        raise RuntimeError(
            f"{ENV_VAR} is not set. This service has no other authentication, "
            "so it refuses to start rather than listen unprotected. Generate a "
            "value with `openssl rand -hex 32` and set it for every internal "
            "service and for the app that calls them."
        )
    return f"Bearer {secret}".encode("utf-8")


def install_service_auth(app: FastAPI) -> None:
    """Require a bearer token on everything except the health endpoints."""
    expected = _expected_header()

    @app.middleware("http")
    async def _require_shared_secret(request: Request, call_next):
        if request.url.path in OPEN_PATHS:
            return await call_next(request)
        presented = request.headers.get("authorization", "").encode("utf-8")
        # compare_digest rather than ==: a comparison that returns at the
        # first differing byte tells an attacker, over enough attempts, how
        # long a matching prefix they have found.
        if not hmac.compare_digest(presented, expected):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        return await call_next(request)

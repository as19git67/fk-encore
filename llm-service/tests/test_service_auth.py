"""The shared-secret gate in front of this service.

The service binds 0.0.0.0:8000 in its container and has no other
authentication; in the production stack it publishes no host port, but any
container on the same bridge network could reach it. These pin that the gate
is actually installed on this app — the module is duplicated per image, so
each one has to be checked on its own.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest
from fastapi import FastAPI
from starlette.testclient import TestClient

import service_auth

SECRET = os.environ["INTERNAL_SERVICE_SECRET"]
MODULE_DIR_COPY = "\0never\0"
MAIN_RELATIVE_PATH = "main.py"


def test_refuses_to_start_without_a_secret(monkeypatch):
    # Mandatory, not optional: a misconfigured deployment must fail at boot
    # rather than listen unprotected.
    monkeypatch.delenv(service_auth.ENV_VAR, raising=False)
    with pytest.raises(RuntimeError, match=service_auth.ENV_VAR):
        service_auth.install_service_auth(FastAPI())


def test_refuses_an_empty_secret(monkeypatch):
    monkeypatch.setenv(service_auth.ENV_VAR, "   ")
    with pytest.raises(RuntimeError, match=service_auth.ENV_VAR):
        service_auth.install_service_auth(FastAPI())


@pytest.fixture
def guarded_client():
    app = FastAPI()
    service_auth.install_service_auth(app)

    @app.get("/health")
    async def health():
        return {"status": "ok"}

    @app.get("/work")
    async def work():
        return {"done": True}

    # Built with no default header so each case states its own credentials.
    with TestClient(app, headers={}) as client:
        yield client


def test_health_stays_open(guarded_client):
    # The container healthcheck is a plain curl; keeping credentials out of
    # the compose file is worth more than guarding a liveness probe.
    assert guarded_client.get("/health", headers={}).status_code == 200


def test_rejects_a_request_with_no_credentials(guarded_client):
    resp = guarded_client.get("/work", headers={})
    assert resp.status_code == 401
    assert resp.json() == {"error": "unauthorized"}


def test_rejects_a_wrong_secret(guarded_client):
    resp = guarded_client.get("/work", headers={"authorization": "Bearer nope"})
    assert resp.status_code == 401


def test_rejects_a_prefix_of_the_secret(guarded_client):
    resp = guarded_client.get(
        "/work", headers={"authorization": f"Bearer {SECRET[:-1]}"}
    )
    assert resp.status_code == 401


def test_rejects_the_bare_secret_without_the_scheme(guarded_client):
    resp = guarded_client.get("/work", headers={"authorization": SECRET})
    assert resp.status_code == 401


def test_accepts_the_secret(guarded_client):
    resp = guarded_client.get("/work", headers={"authorization": f"Bearer {SECRET}"})
    assert resp.status_code == 200
    assert resp.json() == {"done": True}


def test_main_installs_the_gate():
    """The module above is only worth anything if main.py actually calls it.

    Checked against the source rather than by making a request: bringing the
    real app up would run its lifespan, which loads models and downloads
    weights. What matters here is one line of wiring, and its absence is
    exactly what this catches.
    """
    main_py = Path(__file__).resolve().parents[1] / MAIN_RELATIVE_PATH
    source = main_py.read_text(encoding="utf-8")
    assert "install_service_auth(app)" in source, (
        f"{main_py} does not install the shared-secret gate"
    )


@pytest.mark.parametrize("name", ["Dockerfile", "Dockerfile.gpu"])
def test_dockerfile_ships_the_module(name):
    """The gate has to be *in the image*, not just in the repository.

    Four of the five Dockerfiles copy main.py by name rather than the whole
    directory, so adding service_auth.py next to it was not enough: the
    containers died at import with ModuleNotFoundError while every test here
    passed, because pytest runs against the source tree. This is the check
    that would have caught it.

    Both of this service's Dockerfiles are checked, because the first fix
    covered only the CPU one and left the CUDA image broken in exactly the
    same way — a second COPY line is a second chance to forget.
    """
    dockerfile = Path(__file__).resolve().parents[1] / name
    source = dockerfile.read_text(encoding="utf-8")
    copied = [l for l in source.splitlines() if l.startswith("COPY")]
    assert any("service_auth.py" in l or MODULE_DIR_COPY in l for l in copied), (
        f"{dockerfile} never copies service_auth.py into the image"
    )

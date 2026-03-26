"""Tests for FastAPI route handlers (endpoints).

All heavy dependencies (ML models, DB, pillow-heif) are mocked so the tests
run in a lightweight CI environment without GPU/model downloads.
"""

import sys
import os
import types
import importlib

import pytest
from unittest.mock import AsyncMock, MagicMock, patch

# ---------------------------------------------------------------------------
# Stub out heavy optional imports BEFORE any app code is loaded
# ---------------------------------------------------------------------------

# pillow-heif
pillow_heif_stub = types.ModuleType("pillow_heif")
pillow_heif_stub.register_heif_opener = lambda: None
sys.modules.setdefault("pillow_heif", pillow_heif_stub)

# torch
torch_stub = types.ModuleType("torch")
torch_stub.no_grad = lambda: (lambda f: f)  # passthrough decorator
torch_stub.device = lambda x: x
torch_stub.cuda = MagicMock()
torch_stub.cuda.is_available = lambda: False
sys.modules.setdefault("torch", torch_stub)

# open_clip
sys.modules.setdefault("open_clip", MagicMock())

# transformers
sys.modules.setdefault("transformers", MagicMock())

# app.config – minimal stub
config_stub = types.ModuleType("app.config")

class _Settings:
    log_level = "INFO"
    clip_model_name = "ViT-B-32"
    clip_pretrained = "openai"
    dino_model_name = "facebook/dinov2-base"

config_stub.settings = _Settings()
sys.modules["app.config"] = config_stub

# app.db.database stub
db_database_stub = types.ModuleType("app.db.database")
db_database_stub.check_db_connection = AsyncMock(return_value=True)
db_database_stub.get_db = MagicMock()
db_database_stub.ensure_database_exists = AsyncMock()
db_database_stub.run_migrations = AsyncMock()
sys.modules["app.db.database"] = db_database_stub
sys.modules["app.db"] = types.ModuleType("app.db")

# app.db.repository stub
repo_stub = types.ModuleType("app.db.repository")
repo_stub.get_existing_photo_ids = AsyncMock(return_value=set())
repo_stub.upsert_photos = AsyncMock(return_value=1)
repo_stub.get_photos_by_ids = AsyncMock(return_value=[])
repo_stub.search_by_clip = AsyncMock(return_value=[])
repo_stub.search_by_dino = AsyncMock(return_value=[])
sys.modules["app.db.repository"] = repo_stub

# app.services.embedding_service stub
embed_stub = types.ModuleType("app.services.embedding_service")

class _FakeCLIPEmbedder:
    _instance = None

    @classmethod
    def get_instance(cls, **kwargs):
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def embed(self, images):
        return [[0.1] * 512 for _ in images]

    def embed_text(self, text):
        return [0.1] * 512

class _FakeDINOEmbedder:
    _instance = None

    @classmethod
    def get_instance(cls, **kwargs):
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def embed(self, images):
        return [[0.2] * 768 for _ in images]

embed_stub.CLIPEmbedder = _FakeCLIPEmbedder
embed_stub.DINOv2Embedder = _FakeDINOEmbedder
sys.modules["app.services.embedding_service"] = embed_stub
sys.modules["app.services"] = types.ModuleType("app.services")

# ---------------------------------------------------------------------------
# Now it is safe to import FastAPI test client and the router
# ---------------------------------------------------------------------------

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from fastapi import FastAPI
from fastapi.testclient import TestClient
from app.api.endpoints import router

app = FastAPI()
app.include_router(router)
client = TestClient(app)

# Provide a fake DB session via dependency override
from app.db.database import get_db

async def override_get_db():
    yield MagicMock()

app.dependency_overrides[get_db] = override_get_db


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestHealthEndpoint:
    def test_returns_ok_when_db_healthy(self):
        db_database_stub.check_db_connection = AsyncMock(return_value=True)
        response = client.get("/health")
        assert response.status_code == 200
        body = response.json()
        assert body["status"] == "ok"
        assert body["db"] == "ok"
        assert "models" in body

    def test_returns_degraded_when_db_down(self):
        db_database_stub.check_db_connection = AsyncMock(return_value=False)
        response = client.get("/health")
        assert response.status_code == 200
        body = response.json()
        assert body["status"] == "degraded"
        assert body["db"] == "error"
        # restore
        db_database_stub.check_db_connection = AsyncMock(return_value=True)


class TestEmbedEndpoint:
    def test_skips_already_existing_photos(self):
        repo_stub.get_existing_photo_ids = AsyncMock(return_value={"p1"})
        payload = {"photos": [{"photo_id": "p1", "file_path": "/tmp/a.jpg"}]}
        response = client.post("/embed", json=payload)
        assert response.status_code == 200
        assert response.json()["processed"] == 0
        repo_stub.get_existing_photo_ids = AsyncMock(return_value=set())

    def test_empty_photos_array_rejected(self):
        response = client.post("/embed", json={"photos": []})
        assert response.status_code == 422

    def test_missing_photos_field_rejected(self):
        response = client.post("/embed", json={})
        assert response.status_code == 422


class TestSearchEndpoint:
    def test_photo_not_found_returns_404(self):
        repo_stub.get_photos_by_ids = AsyncMock(return_value=[])
        response = client.post("/search", json={"photo_id": "missing"})
        assert response.status_code == 404

    def test_invalid_mode_rejected(self):
        response = client.post("/search", json={"photo_id": "p1", "mode": "invalid"})
        assert response.status_code == 422

    def test_k_out_of_range_rejected(self):
        response = client.post("/search", json={"photo_id": "p1", "k": 0})
        assert response.status_code == 422

        response = client.post("/search", json={"photo_id": "p1", "k": 101})
        assert response.status_code == 422


class TestGetEndpoint:
    def test_returns_empty_list_for_unknown_ids(self):
        repo_stub.get_photos_by_ids = AsyncMock(return_value=[])
        response = client.post("/get", json={"photo_ids": ["unknown"]})
        assert response.status_code == 200
        assert response.json()["photos"] == []

    def test_empty_photo_ids_rejected(self):
        response = client.post("/get", json={"photo_ids": []})
        assert response.status_code == 422


class TestTextSearchEndpoint:
    def test_empty_query_rejected(self):
        response = client.post("/search/text", json={"query": ""})
        assert response.status_code == 422

    def test_valid_query_returns_results(self):
        repo_stub.search_by_clip = AsyncMock(return_value=[("p1", 0.95), ("p2", 0.85)])
        response = client.post("/search/text", json={"query": "sunset beach", "threshold": 0.5})
        assert response.status_code == 200
        results = response.json()["results"]
        assert len(results) == 2
        assert results[0]["photo_id"] == "p1"
        repo_stub.search_by_clip = AsyncMock(return_value=[])

    def test_threshold_filters_low_scores(self):
        repo_stub.search_by_clip = AsyncMock(return_value=[("p1", 0.95), ("p2", 0.10)])
        response = client.post("/search/text", json={"query": "mountains", "threshold": 0.5})
        assert response.status_code == 200
        results = response.json()["results"]
        assert len(results) == 1
        assert results[0]["photo_id"] == "p1"
        repo_stub.search_by_clip = AsyncMock(return_value=[])

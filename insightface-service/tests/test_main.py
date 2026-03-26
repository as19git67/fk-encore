"""Tests for insightface-service FastAPI endpoints.

InsightFace and OpenCV are mocked so the tests run in CI without GPU or
model downloads.
"""

import sys
import io
import types
import numpy as np
import pytest
from unittest.mock import MagicMock, patch

# ---------------------------------------------------------------------------
# Stub heavy dependencies before importing the app
# ---------------------------------------------------------------------------

# cv2 stub
cv2_stub = types.ModuleType("cv2")
cv2_stub.IMREAD_COLOR = 1
cv2_stub.imdecode = MagicMock(return_value=np.zeros((100, 100, 3), dtype=np.uint8))
sys.modules["cv2"] = cv2_stub

# insightface stubs
insightface_stub = types.ModuleType("insightface")
insightface_app_stub = types.ModuleType("insightface.app")

class _FaceMock:
    def __init__(self, embedding=None, bbox=None, kps=None):
        self.embedding = embedding if embedding is not None else np.random.rand(512).astype(np.float32)
        self.bbox = bbox if bbox is not None else np.array([10.0, 10.0, 90.0, 90.0])
        self.kps = kps if kps is not None else np.zeros((5, 2))

class _FakeAnalysis:
    def __init__(self, *args, **kwargs):
        pass

    def prepare(self, *args, **kwargs):
        pass

    def get(self, img):
        # Return one detected face by default
        return [_FaceMock()]

insightface_app_stub.FaceAnalysis = _FakeAnalysis
insightface_stub.app = insightface_app_stub
sys.modules["insightface"] = insightface_stub
sys.modules["insightface.app"] = insightface_app_stub

# ---------------------------------------------------------------------------
# Import app AFTER stubs are in place
# ---------------------------------------------------------------------------

sys.path.insert(0, __import__("os").path.join(__import__("os").path.dirname(__file__), ".."))

import importlib
import main as insightface_main
importlib.reload(insightface_main)

from fastapi.testclient import TestClient

client = TestClient(insightface_main.app)


def _make_image_file(filename: str = "test.jpg") -> bytes:
    """Return minimal JPEG-like bytes (just noise – cv2 is mocked)."""
    return b"\xff\xd8\xff" + b"\x00" * 100


# ---------------------------------------------------------------------------
# /embedding
# ---------------------------------------------------------------------------

class TestEmbeddingEndpoint:
    def test_returns_embedding_for_valid_image(self):
        data = {"file": ("photo.jpg", _make_image_file(), "image/jpeg")}
        response = client.post("/embedding", files=data)
        assert response.status_code == 200
        body = response.json()
        assert "embedding" in body
        assert isinstance(body["embedding"], list)
        assert len(body["embedding"]) > 0

    def test_no_face_returns_error_key(self):
        with patch.object(insightface_main.app_state, "get", return_value=[]):
            data = {"file": ("photo.jpg", _make_image_file(), "image/jpeg")}
            response = client.post("/embedding", files=data)
        assert response.status_code == 200
        assert response.json().get("error") == "no face detected"

    def test_empty_file_returns_422(self):
        data = {"file": ("empty.jpg", b"", "image/jpeg")}
        # cv2.imdecode returns None for empty bytes in real code;
        # mock imdecode to simulate failure
        cv2_stub.imdecode = MagicMock(return_value=None)
        response = client.post("/embedding", files=data)
        assert response.status_code == 422
        cv2_stub.imdecode = MagicMock(return_value=np.zeros((100, 100, 3), dtype=np.uint8))


# ---------------------------------------------------------------------------
# /verify
# ---------------------------------------------------------------------------

class TestVerifyEndpoint:
    def test_returns_similarity_for_two_faces(self):
        files = {
            "file1": ("a.jpg", _make_image_file(), "image/jpeg"),
            "file2": ("b.jpg", _make_image_file(), "image/jpeg"),
        }
        response = client.post("/verify", files=files)
        assert response.status_code == 200
        body = response.json()
        assert "similarity" in body
        assert isinstance(body["similarity"], float)
        assert -1.0 <= body["similarity"] <= 1.0

    def test_missing_face_returns_error_key(self):
        with patch.object(insightface_main.app_state, "get", return_value=[]):
            files = {
                "file1": ("a.jpg", _make_image_file(), "image/jpeg"),
                "file2": ("b.jpg", _make_image_file(), "image/jpeg"),
            }
            response = client.post("/verify", files=files)
        assert response.status_code == 200
        assert response.json().get("error") == "face missing"


# ---------------------------------------------------------------------------
# /detect
# ---------------------------------------------------------------------------

class TestDetectEndpoint:
    def test_returns_faces_list(self):
        data = {"file": ("photo.jpg", _make_image_file(), "image/jpeg")}
        response = client.post("/detect", files=data)
        assert response.status_code == 200
        body = response.json()
        assert "faces" in body
        assert "width" in body
        assert "height" in body
        assert isinstance(body["faces"], list)
        assert len(body["faces"]) == 1
        face = body["faces"][0]
        assert "bbox" in face
        assert "kps" in face
        assert "embedding" in face

    def test_returns_empty_list_when_no_faces(self):
        with patch.object(insightface_main.app_state, "get", return_value=[]):
            data = {"file": ("photo.jpg", _make_image_file(), "image/jpeg")}
            response = client.post("/detect", files=data)
        assert response.status_code == 200
        body = response.json()
        assert body["faces"] == []

    def test_image_dimensions_in_response(self):
        fake_img = np.zeros((480, 640, 3), dtype=np.uint8)
        cv2_stub.imdecode = MagicMock(return_value=fake_img)
        data = {"file": ("photo.jpg", _make_image_file(), "image/jpeg")}
        response = client.post("/detect", files=data)
        assert response.status_code == 200
        body = response.json()
        assert body["height"] == 480
        assert body["width"] == 640
        # restore default mock
        cv2_stub.imdecode = MagicMock(return_value=np.zeros((100, 100, 3), dtype=np.uint8))

"""Tests for insightface-service FastAPI endpoints.

InsightFace and OpenCV are mocked so the tests run in CI without GPU or
model downloads.
"""

import os
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


# ---------------------------------------------------------------------------
# ORT thread-cap monkey-patch (regression test for the
# `pthread_setaffinity_np failed … mask: {14, }` warning observed under
# the production cpuset=0-11 pinning).
# ---------------------------------------------------------------------------

class TestOrtThreadCap:
    """Build a tiny `onnxruntime` stub, run _install_ort_thread_cap()
    against it, and assert the patched __init__ injects SessionOptions
    on calls that don't supply their own.
    """

    def _build_ort_stub(self):
        ort_stub = types.ModuleType("onnxruntime")

        class _SessionOptions:
            def __init__(self):
                self.intra_op_num_threads = 0
                self.inter_op_num_threads = 0

        captured = {}

        class _InferenceSession:
            def __init__(self, path_or_bytes, sess_options=None, *args, **kwargs):
                captured["sess_options"] = sess_options
                captured["path"] = path_or_bytes
                captured["kwargs"] = kwargs

        ort_stub.SessionOptions = _SessionOptions
        ort_stub.InferenceSession = _InferenceSession
        return ort_stub, captured

    def test_patch_injects_session_options_when_caller_passes_none(self, monkeypatch):
        ort_stub, captured = self._build_ort_stub()
        monkeypatch.setitem(sys.modules, "onnxruntime", ort_stub)
        monkeypatch.setenv("ORT_INTRA_OP_NUM_THREADS", "8")

        insightface_main._install_ort_thread_cap()
        ort_stub.InferenceSession("model.onnx", providers=["CPUExecutionProvider"])

        assert captured["sess_options"] is not None
        assert captured["sess_options"].intra_op_num_threads == 8
        assert captured["sess_options"].inter_op_num_threads == 1

    def test_patch_respects_explicit_session_options(self, monkeypatch):
        ort_stub, captured = self._build_ort_stub()
        monkeypatch.setitem(sys.modules, "onnxruntime", ort_stub)
        monkeypatch.setenv("ORT_INTRA_OP_NUM_THREADS", "4")

        insightface_main._install_ort_thread_cap()
        explicit = ort_stub.SessionOptions()
        explicit.intra_op_num_threads = 2
        ort_stub.InferenceSession("model.onnx", sess_options=explicit)

        # Explicit options must not be overridden.
        assert captured["sess_options"] is explicit
        assert captured["sess_options"].intra_op_num_threads == 2

    def test_patch_is_idempotent(self, monkeypatch):
        ort_stub, _ = self._build_ort_stub()
        monkeypatch.setitem(sys.modules, "onnxruntime", ort_stub)

        insightface_main._install_ort_thread_cap()
        first = ort_stub.InferenceSession.__init__
        insightface_main._install_ort_thread_cap()
        second = ort_stub.InferenceSession.__init__

        assert first is second
        assert getattr(second, "_fk_ort_thread_cap", False) is True

    def test_thread_count_falls_back_to_sched_getaffinity(self, monkeypatch):
        monkeypatch.delenv("ORT_INTRA_OP_NUM_THREADS", raising=False)
        if not hasattr(os, "sched_getaffinity"):
            pytest.skip("sched_getaffinity unavailable on this platform")

        # Real cpuset count on the test host — just assert sanity.
        n = insightface_main._onnx_intra_op_threads()
        assert n >= 1
        assert n == len(os.sched_getaffinity(0))

    def test_thread_count_env_override_wins(self, monkeypatch):
        monkeypatch.setenv("ORT_INTRA_OP_NUM_THREADS", "3")
        assert insightface_main._onnx_intra_op_threads() == 3

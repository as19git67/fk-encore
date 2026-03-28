"""Tests for landmark-service FastAPI endpoints.

torch and transformers are mocked so the tests run in CI without GPU or
model downloads.
"""

from __future__ import annotations

import io
import os
import sys
import types
from unittest.mock import patch

# ---------------------------------------------------------------------------
# Stub heavy dependencies before importing the app
# ---------------------------------------------------------------------------

# --- torch stub ---
torch_stub = types.ModuleType("torch")


class _FakeTensor:
    def __init__(self, data=None):
        self._data = data if data is not None else []

    def tolist(self):
        return self._data

    def to(self, device):
        return self


class _FakeNoGrad:
    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass


torch_stub.device = lambda name: name
torch_stub.cuda = types.SimpleNamespace(is_available=lambda: False)
torch_stub.no_grad = lambda: _FakeNoGrad()
torch_stub.tensor = lambda data, **kwargs: _FakeTensor(data)
sys.modules["torch"] = torch_stub

# --- transformers stub ---
transformers_stub = types.ModuleType("transformers")

# Default detections returned by post_process (two landmarks).
# Coordinates must fit within the default test image (200×150).
_DEFAULT_DETECTIONS = [
    {
        "scores": _FakeTensor([0.87, 0.65]),
        "labels": ["church", "tower"],
        "boxes": _FakeTensor([[20.0, 10.0, 100.0, 80.0], [110.0, 30.0, 180.0, 120.0]]),
    }
]


class _FakeInputs(dict):
    """Dict subclass that also exposes input_ids as an attribute."""

    def to(self, device):
        return self

    @property
    def input_ids(self):
        return None


class _FakeProcessor:
    @classmethod
    def from_pretrained(cls, model_id):
        return cls()

    def __call__(self, images, text, return_tensors):
        return _FakeInputs()

    def post_process_grounded_object_detection(
        self, outputs, input_ids, box_threshold, text_threshold, target_sizes
    ):
        return _DEFAULT_DETECTIONS


class _FakeModel:
    @classmethod
    def from_pretrained(cls, model_id):
        return cls()

    def to(self, device):
        return self

    def eval(self):
        return self

    def __call__(self, **kwargs):
        return {}


transformers_stub.AutoProcessor = _FakeProcessor
transformers_stub.AutoModelForZeroShotObjectDetection = _FakeModel
sys.modules["transformers"] = transformers_stub

# ---------------------------------------------------------------------------
# Import app AFTER stubs are in place
# ---------------------------------------------------------------------------

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import importlib
import main as landmark_main

importlib.reload(landmark_main)

from fastapi.testclient import TestClient
from PIL import Image

client = TestClient(landmark_main.app)


def _make_image_bytes(width: int = 200, height: int = 150) -> bytes:
    """Create a small test JPEG image as bytes."""
    img = Image.new("RGB", (width, height), color=(100, 150, 200))
    buf = io.BytesIO()
    img.save(buf, format="JPEG")
    return buf.getvalue()


# ---------------------------------------------------------------------------
# /health
# ---------------------------------------------------------------------------


class TestHealthEndpoint:
    def test_returns_ok_status(self):
        response = client.get("/health")
        assert response.status_code == 200
        assert response.json()["status"] == "ok"

    def test_returns_device_field(self):
        response = client.get("/health")
        body = response.json()
        assert "device" in body
        assert isinstance(body["device"], str)

    def test_returns_model_field(self):
        response = client.get("/health")
        body = response.json()
        assert "model" in body
        assert len(body["model"]) > 0


# ---------------------------------------------------------------------------
# /detect-landmarks
# ---------------------------------------------------------------------------


class TestDetectLandmarksEndpoint:
    def test_returns_200_for_valid_image(self):
        files = {"file": ("photo.jpg", _make_image_bytes(), "image/jpeg")}
        response = client.post("/detect-landmarks", files=files)
        assert response.status_code == 200

    def test_response_has_required_top_level_keys(self):
        files = {"file": ("photo.jpg", _make_image_bytes(), "image/jpeg")}
        response = client.post("/detect-landmarks", files=files)
        body = response.json()
        assert "landmarks" in body
        assert "width" in body
        assert "height" in body

    def test_landmarks_is_a_list(self):
        files = {"file": ("photo.jpg", _make_image_bytes(), "image/jpeg")}
        response = client.post("/detect-landmarks", files=files)
        assert isinstance(response.json()["landmarks"], list)

    def test_each_landmark_has_required_fields(self):
        files = {"file": ("photo.jpg", _make_image_bytes(), "image/jpeg")}
        response = client.post("/detect-landmarks", files=files)
        for lm in response.json()["landmarks"]:
            assert "label" in lm
            assert "confidence" in lm
            assert "bbox" in lm

    def test_each_bbox_has_required_fields(self):
        files = {"file": ("photo.jpg", _make_image_bytes(), "image/jpeg")}
        response = client.post("/detect-landmarks", files=files)
        for lm in response.json()["landmarks"]:
            bbox = lm["bbox"]
            for key in ("x", "y", "width", "height"):
                assert key in bbox

    def test_landmark_labels_are_strings(self):
        files = {"file": ("photo.jpg", _make_image_bytes(), "image/jpeg")}
        response = client.post("/detect-landmarks", files=files)
        for lm in response.json()["landmarks"]:
            assert isinstance(lm["label"], str)

    def test_confidence_is_float_between_0_and_1(self):
        files = {"file": ("photo.jpg", _make_image_bytes(), "image/jpeg")}
        response = client.post("/detect-landmarks", files=files)
        for lm in response.json()["landmarks"]:
            conf = lm["confidence"]
            assert isinstance(conf, float)
            assert 0.0 <= conf <= 1.0

    def test_bbox_values_are_normalized(self):
        """All bbox values must be in [0, 1]."""
        files = {"file": ("photo.jpg", _make_image_bytes(), "image/jpeg")}
        response = client.post("/detect-landmarks", files=files)
        for lm in response.json()["landmarks"]:
            for key in ("x", "y", "width", "height"):
                val = lm["bbox"][key]
                assert 0.0 <= val <= 1.0, f"bbox.{key}={val} out of range"

    def test_image_dimensions_match_input(self):
        files = {"file": ("photo.jpg", _make_image_bytes(width=320, height=240), "image/jpeg")}
        response = client.post("/detect-landmarks", files=files)
        body = response.json()
        assert body["width"] == 320
        assert body["height"] == 240

    def test_detections_count_matches_model_output(self):
        # Use a short custom class string so only one batch is needed,
        # making the expected count predictable (= 2 from _DEFAULT_DETECTIONS).
        files = {"file": ("photo.jpg", _make_image_bytes(), "image/jpeg")}
        data = {"classes": "church . tower"}
        response = client.post("/detect-landmarks", files=files, data=data)
        # _DEFAULT_DETECTIONS has 2 results and one batch → 2 landmarks
        assert len(response.json()["landmarks"]) == 2

    def test_no_detections_returns_empty_list(self):
        empty = [{"scores": _FakeTensor([]), "labels": [], "boxes": _FakeTensor([])}]
        with patch.object(
            landmark_main.processor,
            "post_process_grounded_object_detection",
            return_value=empty,
        ):
            files = {"file": ("photo.jpg", _make_image_bytes(), "image/jpeg")}
            response = client.post("/detect-landmarks", files=files)
        assert response.status_code == 200
        assert response.json()["landmarks"] == []

    def test_accepts_custom_classes_form_field(self):
        files = {"file": ("photo.jpg", _make_image_bytes(), "image/jpeg")}
        data = {"classes": "pyramid . sphinx"}
        response = client.post("/detect-landmarks", files=files, data=data)
        assert response.status_code == 200

    def test_accepts_custom_threshold_form_field(self):
        files = {"file": ("photo.jpg", _make_image_bytes(), "image/jpeg")}
        data = {"threshold": "0.5"}
        response = client.post("/detect-landmarks", files=files, data=data)
        assert response.status_code == 200

    def test_missing_file_returns_422(self):
        response = client.post("/detect-landmarks")
        assert response.status_code == 422

    def test_bbox_normalization_is_correct(self):
        """Verify exact bbox normalization math."""
        # Image 200×150, box [100, 50, 150, 100]
        # Expected: x=0.5, y=0.3333, width=0.25, height=0.3333
        single = [
            {
                "scores": _FakeTensor([0.9]),
                "labels": ["bridge"],
                "boxes": _FakeTensor([[100.0, 50.0, 150.0, 100.0]]),
            }
        ]
        with patch.object(
            landmark_main.processor,
            "post_process_grounded_object_detection",
            return_value=single,
        ):
            files = {"file": ("photo.jpg", _make_image_bytes(width=200, height=150), "image/jpeg")}
            response = client.post("/detect-landmarks", files=files, data={"classes": "bridge"})

        body = response.json()
        assert len(body["landmarks"]) == 1
        lm = body["landmarks"][0]
        assert lm["label"] == "bridge"
        assert lm["confidence"] == 0.9
        bbox = lm["bbox"]
        assert bbox["x"] == round(100.0 / 200, 4)       # 0.5
        assert bbox["y"] == round(50.0 / 150, 4)        # 0.3333
        assert bbox["width"] == round(50.0 / 200, 4)    # 0.25
        assert bbox["height"] == round(50.0 / 150, 4)   # 0.3333

    def test_confidence_is_rounded_to_4_decimal_places(self):
        """Confidence values should be rounded to 4 decimal places."""
        precise = [
            {
                "scores": _FakeTensor([0.123456789]),
                "labels": ["castle"],
                "boxes": _FakeTensor([[0.0, 0.0, 10.0, 10.0]]),
            }
        ]
        with patch.object(
            landmark_main.processor,
            "post_process_grounded_object_detection",
            return_value=precise,
        ):
            files = {"file": ("photo.jpg", _make_image_bytes(), "image/jpeg")}
            response = client.post("/detect-landmarks", files=files)

        lm = response.json()["landmarks"][0]
        # round(0.123456789, 4) == 0.1235
        assert lm["confidence"] == round(0.123456789, 4)

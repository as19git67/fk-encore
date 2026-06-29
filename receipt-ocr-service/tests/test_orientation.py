"""Tests for orientation normalization and the geometry-correction wrapper.

These run without a loaded PaddleOCR model, so orientation detection is a no-op
(it returns 0 when `_state["ocr"]` is None). They cover the deterministic parts:
the lossless 90° rotations and the crop/no-crop reporting of `correct_geometry`.
"""

import cv2
import numpy as np

from main import (
    _detect_orientation,
    _rotate_90s,
    correct_geometry,
)


def _encode_png(img: np.ndarray) -> bytes:
    ok, buf = cv2.imencode(".png", img)
    assert ok
    return buf.tobytes()


def test_rotate_90s_swaps_dimensions():
    img = np.zeros((40, 20, 3), dtype=np.uint8)
    assert _rotate_90s(img, 0).shape == (40, 20, 3)
    assert _rotate_90s(img, 90).shape == (20, 40, 3)
    assert _rotate_90s(img, 180).shape == (40, 20, 3)
    assert _rotate_90s(img, 270).shape == (20, 40, 3)


def test_rotate_90s_180_is_involution():
    img = np.arange(40 * 20 * 3, dtype=np.uint8).reshape(40, 20, 3)
    twice = _rotate_90s(_rotate_90s(img, 180), 180)
    assert np.array_equal(twice, img)


def test_detect_orientation_zero_without_model():
    # No OCR model is loaded in unit tests → orientation is left unchanged.
    img = np.zeros((100, 60, 3), dtype=np.uint8)
    assert _detect_orientation(img) == 0


def test_correct_geometry_reports_crop_on_receipt():
    img = np.zeros((900, 700, 3), dtype=np.uint8)
    cv2.rectangle(img, (150, 120), (550, 780), (255, 255, 255), -1)
    out, corrected = correct_geometry(_encode_png(img))
    assert corrected is True
    assert out.ndim == 3 and out.shape[2] == 3
    assert out.shape[0] < 900 and out.shape[1] < 700  # cropped to the receipt


def test_correct_geometry_no_change_on_uniform_frame():
    img = np.full((400, 300, 3), 180, dtype=np.uint8)
    out, corrected = correct_geometry(_encode_png(img))
    assert corrected is False
    assert out.shape[0] == 400 and out.shape[1] == 300  # full frame kept

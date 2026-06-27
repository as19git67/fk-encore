"""Tests for the contour-based auto-crop / perspective-correction helpers."""

import cv2
import numpy as np

from main import (
    _find_document_quad,
    _four_point_warp,
    _order_quad,
    preprocess_image,
)


def _encode_png(img: np.ndarray) -> bytes:
    ok, buf = cv2.imencode(".png", img)
    assert ok
    return buf.tobytes()


def test_order_quad_orders_corners():
    # Corners of a rectangle handed in out of order.
    tl, tr, br, bl = [10, 10], [110, 12], [108, 210], [8, 208]
    shuffled = np.array([br, tl, bl, tr], dtype=np.float32)
    rect = _order_quad(shuffled)
    assert list(rect[0]) == tl
    assert list(rect[1]) == tr
    assert list(rect[2]) == br
    assert list(rect[3]) == bl


def test_find_document_quad_on_clear_rectangle():
    img = np.zeros((800, 600), dtype=np.uint8)          # black background
    cv2.rectangle(img, (120, 100), (480, 700), 255, -1)  # white "receipt"
    quad = _find_document_quad(img)
    assert quad is not None
    rect = _order_quad(quad)
    assert abs(rect[0][0] - 120) < 30 and abs(rect[0][1] - 100) < 30
    assert abs(rect[2][0] - 480) < 30 and abs(rect[2][1] - 700) < 30


def test_find_document_quad_none_on_uniform_image():
    img = np.full((400, 300), 200, dtype=np.uint8)  # no edges at all
    assert _find_document_quad(img) is None


def test_find_document_quad_none_when_region_too_small():
    img = np.zeros((800, 600), dtype=np.uint8)
    cv2.rectangle(img, (10, 10), (90, 90), 255, -1)  # ~1.3% of the frame
    assert _find_document_quad(img) is None


def test_four_point_warp_crops_to_quad():
    img = np.zeros((800, 600, 3), dtype=np.uint8)
    cv2.rectangle(img, (120, 100), (480, 700), (255, 255, 255), -1)
    quad = np.array([[120, 100], [480, 100], [480, 700], [120, 700]], dtype=np.float32)
    warped = _four_point_warp(img, quad)
    assert warped.shape[0] == 600  # 700 - 100
    assert warped.shape[1] == 360  # 480 - 120


def test_preprocess_image_crops_receipt_on_background():
    img = np.zeros((900, 700, 3), dtype=np.uint8)
    cv2.rectangle(img, (150, 120), (550, 780), (255, 255, 255), -1)
    out = preprocess_image(_encode_png(img))
    assert out.ndim == 3 and out.shape[2] == 3       # 3-channel for PaddleOCR
    assert out.shape[0] < 900 and out.shape[1] < 700  # cropped to the receipt


def test_preprocess_image_keeps_full_frame_without_border():
    # A near-uniform frame has no detectable quad — the full frame is kept.
    img = np.full((400, 300, 3), 180, dtype=np.uint8)
    out = preprocess_image(_encode_png(img))
    assert out.shape[0] == 400 and out.shape[1] == 300

"""Tests for the contour-based auto-crop / perspective-correction helpers."""

import base64

import cv2
import numpy as np

from main import (
    _crop_to_ocr_content,
    _find_document_quad,
    _four_point_warp,
    _encode_processed_jpeg,
    _order_quad,
    enhance_for_ocr,
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


def _ocr_line(text, left, top, right, bottom, confidence=0.99):
    return {
        "text": text,
        "confidence": confidence,
        "box": [[left, top], [right, top], [right, bottom], [left, bottom]],
    }


def test_ocr_content_fallback_removes_large_camera_border():
    img = np.zeros((1000, 800, 3), dtype=np.uint8)
    lines = [
        _ocr_line("Deutsche Post", 220, 180, 570, 220),
        _ocr_line("Bruttoumsatz 7,69 EUR", 210, 760, 590, 800),
    ]

    cropped = _crop_to_ocr_content(img, lines)

    assert cropped.shape[0] < img.shape[0]
    assert cropped.shape[1] < img.shape[1]
    assert cropped.shape[0] >= 780 - 180
    assert cropped.shape[1] >= 590 - 210


def test_ocr_content_fallback_keeps_already_tight_scan():
    img = np.zeros((1000, 800, 3), dtype=np.uint8)
    lines = [
        _ocr_line("Kopf", 30, 30, 300, 70),
        _ocr_line("Summe 7,69", 400, 920, 770, 970),
    ]

    cropped = _crop_to_ocr_content(img, lines)

    assert cropped.shape == img.shape


def test_processed_receipt_jpeg_contains_display_enhancement():
    gradient = np.tile(np.linspace(145, 205, 320, dtype=np.uint8), (480, 1))
    img = cv2.cvtColor(gradient, cv2.COLOR_GRAY2BGR)
    cv2.putText(img, "SUMME 12,34", (35, 240), cv2.FONT_HERSHEY_SIMPLEX, 1, (115, 115, 115), 2)

    enhanced = enhance_for_ocr(img)
    encoded = _encode_processed_jpeg(enhanced)
    assert encoded is not None

    decoded = cv2.imdecode(
        np.frombuffer(base64.b64decode(encoded), dtype=np.uint8),
        cv2.IMREAD_COLOR,
    )
    assert decoded.shape == img.shape
    assert np.max(np.abs(decoded[:, :, 0].astype(int) - decoded[:, :, 1].astype(int))) <= 2
    assert np.max(np.abs(decoded[:, :, 1].astype(int) - decoded[:, :, 2].astype(int))) <= 2

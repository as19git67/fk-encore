"""The photo OCR endpoint's geometry (issue #1029).

The engine itself is not exercised here — these pin the parts that decide
whether a caller can put a box around a word: the downscale that keeps big
camera photos affordable, and the conversion of PaddleOCR's pixel quads into
coordinates relative to the image, which is what makes that downscale
invisible to the frontend.
"""

from __future__ import annotations

import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from main import (  # noqa: E402
    PhotoOcrLine,
    PhotoOcrResult,
    char_weighted_confidence,
    normalise_ocr_lines,
    scale_to_long_side,
)


def line(text="Hallo", conf=0.9, box=None, left=10.0, top=20.0, right=110.0, bottom=60.0):
    return {
        "text": text,
        "confidence": conf,
        "box": box if box is not None else [[10, 20], [110, 20], [110, 60], [10, 60]],
        "left": left,
        "top": top,
        "right": right,
        "bottom": bottom,
    }


class TestScaleToLongSide:
    def test_shrinks_a_camera_photo_to_the_budget(self):
        img = np.zeros((3000, 4000, 3), dtype=np.uint8)
        scaled, factor = scale_to_long_side(img, 1600)
        assert max(scaled.shape[:2]) == 1600
        assert factor == pytest.approx(0.4)

    def test_keeps_the_aspect_ratio(self):
        img = np.zeros((1000, 4000, 3), dtype=np.uint8)
        scaled, _ = scale_to_long_side(img, 1600)
        height, width = scaled.shape[:2]
        assert width == 1600
        assert height == pytest.approx(400, abs=1)

    def test_scales_on_the_longer_edge_of_a_portrait_photo(self):
        img = np.zeros((4000, 3000, 3), dtype=np.uint8)
        scaled, _ = scale_to_long_side(img, 1600)
        assert scaled.shape[0] == 1600

    def test_leaves_a_small_image_alone(self):
        img = np.zeros((800, 600, 3), dtype=np.uint8)
        scaled, factor = scale_to_long_side(img, 1600)
        assert scaled.shape == img.shape
        assert factor == 1.0

    def test_never_enlarges(self):
        img = np.zeros((100, 100, 3), dtype=np.uint8)
        scaled, factor = scale_to_long_side(img, 4000)
        assert scaled.shape == img.shape
        assert factor == 1.0

    def test_a_budget_of_zero_disables_scaling(self):
        img = np.zeros((3000, 4000, 3), dtype=np.uint8)
        scaled, factor = scale_to_long_side(img, 0)
        assert scaled.shape == img.shape
        assert factor == 1.0


class TestNormaliseOcrLines:
    def test_expresses_the_box_relative_to_the_image(self):
        out = normalise_ocr_lines([line()], width=200, height=100)
        assert out[0]["left"] == 0.05
        assert out[0]["top"] == 0.2
        assert out[0]["right"] == 0.55
        assert out[0]["bottom"] == 0.6

    def test_keeps_the_quadrilateral_of_skewed_text(self):
        skewed = line(box=[[10, 20], [110, 10], [110, 50], [10, 60]])
        out = normalise_ocr_lines([skewed], width=200, height=100)
        assert out[0]["polygon"] == [
            [0.05, 0.2],
            [0.55, 0.1],
            [0.55, 0.5],
            [0.05, 0.6],
        ]

    def test_the_same_photo_at_two_scales_yields_the_same_coordinates(self):
        small = normalise_ocr_lines([line()], width=200, height=100)
        big = normalise_ocr_lines(
            [line(box=[[20, 40], [220, 40], [220, 120], [20, 120]],
                  left=20.0, top=40.0, right=220.0, bottom=120.0)],
            width=400,
            height=200,
        )
        assert small[0]["polygon"] == big[0]["polygon"]
        assert small[0]["left"] == big[0]["left"]

    def test_clamps_a_box_that_sticks_out_of_the_image(self):
        out = normalise_ocr_lines(
            [line(box=[[-5, -5], [260, -5], [260, 130], [-5, 130]],
                  left=-5.0, top=-5.0, right=260.0, bottom=130.0)],
            width=200,
            height=100,
        )
        assert out[0]["left"] == 0.0
        assert out[0]["top"] == 0.0
        assert out[0]["right"] == 1.0
        assert out[0]["bottom"] == 1.0
        assert all(0.0 <= x <= 1.0 and 0.0 <= y <= 1.0 for x, y in out[0]["polygon"])

    def test_drops_blank_detections(self):
        assert normalise_ocr_lines([line(text="   ")], width=200, height=100) == []

    def test_trims_the_text(self):
        out = normalise_ocr_lines([line(text="  Hallo  ")], width=200, height=100)
        assert out[0]["text"] == "Hallo"

    def test_survives_a_degenerate_image_size(self):
        assert normalise_ocr_lines([line()], width=0, height=100) == []


class TestCharWeightedConfidence:
    def test_weighs_a_long_line_more_than_a_short_one(self):
        lines = [
            {"text": "a", "confidence": 1.0},
            {"text": "b" * 9, "confidence": 0.5},
        ]
        assert char_weighted_confidence(lines) == pytest.approx(0.55)

    def test_ignores_whitespace_when_counting(self):
        assert char_weighted_confidence([{"text": "a b", "confidence": 0.8}]) == 0.8

    def test_is_zero_without_any_text(self):
        assert char_weighted_confidence([]) == 0.0
        assert char_weighted_confidence([{"text": "", "confidence": 0.9}]) == 0.0


class TestPhotoOcrSchema:
    def test_defaults(self):
        result = PhotoOcrResult()
        assert result.lines == []
        assert result.full_text == ""
        assert result.mean_confidence == 0.0

    def test_carries_a_line_through(self):
        result = PhotoOcrResult(
            lines=[PhotoOcrLine(
                text="Hallo",
                confidence=0.9,
                polygon=[[0.0, 0.0], [0.5, 0.0], [0.5, 0.5], [0.0, 0.5]],
                left=0.0, top=0.0, right=0.5, bottom=0.5,
            )],
            full_text="Hallo",
            mean_confidence=0.9,
        )
        assert result.lines[0].polygon[1] == [0.5, 0.0]

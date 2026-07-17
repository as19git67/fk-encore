"""Tests for the scene_pairs module.

Uses short hardcoded vectors (dim=4) to avoid any platform/numpy-version
dependency in the test data. The find_scene_pairs function is agnostic
to embedding dimension.
"""

import sys
import os

import pytest
import numpy as np

# Ensure the embedding_service root is on sys.path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.services.scene_pairs import find_scene_pairs

DAY = 86400.0
YEAR = 365.25 * DAY

# Two nearly identical 4-dim vectors (cosine sim ≈ 0.9998)
V_A = [0.5, 0.3, -0.2, 0.4]
V_A_SIMILAR = [0.5, 0.3, -0.2, 0.41]

# A completely different vector (cosine sim to V_A ≈ -0.13)
V_DIFFERENT = [-0.3, 0.5, 0.4, -0.1]

# A third vector similar to V_A but slightly different from V_A_SIMILAR
V_A_SIMILAR2 = [0.5, 0.3, -0.2, 0.42]


def _cosine(a: list[float], b: list[float]) -> float:
    """Pure-python cosine similarity for sanity checks."""
    import math
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(x * x for x in b))
    return dot / (na * nb)


class TestFindScenePairs:
    def test_finds_similar_pair_across_time(self):
        cos = _cosine(V_A, V_A_SIMILAR)
        assert cos >= 0.90, f"Test vector setup broken: cosine={cos}"

        items = [
            ("a", 0.0, 0.8, V_A),
            ("b", 3 * YEAR, 0.7, V_A_SIMILAR),
            ("c", 1 * YEAR, 0.5, V_DIFFERENT),
        ]
        pairs = find_scene_pairs(items, 2 * YEAR, 0.90, 10)
        assert len(pairs) == 1, (
            f"Expected 1 pair, got {len(pairs)}. "
            f"numpy={np.__version__}, cosine={cos:.6f}"
        )
        assert pairs[0][0] == "a"  # then
        assert pairs[0][1] == "b"  # now
        assert pairs[0][2] >= 0.90  # similarity
        assert pairs[0][3] >= 730  # time_gap_days

    def test_respects_time_gap_minimum(self):
        items = [
            ("a", 0.0, 0.8, V_A),
            ("b", 0.5 * YEAR, 0.7, V_A_SIMILAR),  # only 6 months apart
        ]
        pairs = find_scene_pairs(items, 2 * YEAR, 0.80, 10)
        assert len(pairs) == 0

    def test_respects_similarity_threshold(self):
        items = [
            ("a", 0.0, 0.8, V_A),
            ("b", 3 * YEAR, 0.7, V_DIFFERENT),  # different scene
        ]
        pairs = find_scene_pairs(items, 2 * YEAR, 0.90, 10)
        assert len(pairs) == 0

    def test_each_photo_used_at_most_once(self):
        items = [
            ("a", 0.0, 0.9, V_A),
            ("b", 3 * YEAR, 0.8, V_A_SIMILAR),
            ("c", 4 * YEAR, 0.7, V_A_SIMILAR2),
        ]
        pairs = find_scene_pairs(items, 2 * YEAR, 0.85, 10)
        assert len(pairs) == 1, (
            f"Expected 1 pair (each photo at most once), got {len(pairs)}. "
            f"numpy={np.__version__}"
        )
        used = {pairs[0][0], pairs[0][1]}
        assert "a" in used

    def test_max_pairs_limit(self):
        items = []
        for i in range(6):
            # Each pair: base vector slightly shifted, well above any threshold
            base = [0.5 + i * 0.01, 0.3, -0.2, 0.4]
            similar = [0.5 + i * 0.01, 0.3, -0.2, 0.41]
            items.append((f"then_{i}", float(i) * DAY, 0.8, base))
            items.append((f"now_{i}", 5 * YEAR + float(i) * DAY, 0.7, similar))
        pairs = find_scene_pairs(items, 2 * YEAR, 0.85, 3)
        assert len(pairs) <= 3

    def test_skips_items_without_embeddings(self):
        items = [
            ("a", 0.0, 0.8, V_A),
            ("b", 3 * YEAR, 0.7, None),
            ("c", 3 * YEAR, 0.6, V_A_SIMILAR),
        ]
        pairs = find_scene_pairs(items, 2 * YEAR, 0.85, 10)
        assert all(p[0] != "b" and p[1] != "b" for p in pairs)
        assert len(pairs) >= 1, (
            f"Expected at least 1 pair (a,c), got {len(pairs)}. "
            f"numpy={np.__version__}"
        )

    def test_empty_input(self):
        assert find_scene_pairs([], 2 * YEAR, 0.90, 10) == []

    def test_single_item(self):
        assert find_scene_pairs(
            [("a", 0.0, 0.8, V_A)],
            2 * YEAR, 0.90, 10
        ) == []

    def test_then_is_always_older(self):
        items = [
            ("newer", 5 * YEAR, 0.8, V_A),
            ("older", 0.0, 0.7, V_A_SIMILAR),
        ]
        pairs = find_scene_pairs(items, 2 * YEAR, 0.85, 10)
        assert len(pairs) == 1, (
            f"Expected 1 pair, got {len(pairs)}. "
            f"numpy={np.__version__}, cosine={_cosine(V_A, V_A_SIMILAR):.6f}"
        )
        assert pairs[0][0] == "older"
        assert pairs[0][1] == "newer"

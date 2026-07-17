"""Tests for the scene_pairs module."""

import math
import sys
import os
import types

import pytest

# Ensure the embedding_service root is on sys.path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.services.scene_pairs import find_scene_pairs


def _make_vec(seed: int, dim: int = 768) -> list[float]:
    """Deterministic pseudo-random unit vector for testing."""
    import random
    rng = random.Random(seed)
    raw = [rng.gauss(0, 1) for _ in range(dim)]
    norm = math.sqrt(sum(x * x for x in raw))
    return [x / norm for x in raw]


def _similar_vec(base: list[float], noise: float = 0.05, seed: int = 42) -> list[float]:
    """Return a vector very similar to base (high cosine similarity)."""
    import random
    rng = random.Random(seed)
    perturbed = [x + rng.gauss(0, noise) for x in base]
    norm = math.sqrt(sum(x * x for x in perturbed))
    return [x / norm for x in perturbed]


DAY = 86400.0
YEAR = 365.25 * DAY


class TestFindScenePairs:
    def test_finds_similar_pair_across_time(self):
        v1 = _make_vec(1)
        v2 = _similar_vec(v1, noise=0.005, seed=10)
        items = [
            ("a", 0.0, 0.8, v1),
            ("b", 3 * YEAR, 0.7, v2),
            ("c", 1 * YEAR, 0.5, _make_vec(99)),
        ]
        pairs = find_scene_pairs(items, 2 * YEAR, 0.90, 10)
        assert len(pairs) == 1
        assert pairs[0][0] == "a"  # then
        assert pairs[0][1] == "b"  # now
        assert pairs[0][2] >= 0.90  # similarity
        assert pairs[0][3] >= 730  # time_gap_days

    def test_respects_time_gap_minimum(self):
        v1 = _make_vec(1)
        v2 = _similar_vec(v1, noise=0.005)
        items = [
            ("a", 0.0, 0.8, v1),
            ("b", 0.5 * YEAR, 0.7, v2),  # only 6 months apart
        ]
        pairs = find_scene_pairs(items, 2 * YEAR, 0.80, 10)
        assert len(pairs) == 0

    def test_respects_similarity_threshold(self):
        items = [
            ("a", 0.0, 0.8, _make_vec(1)),
            ("b", 3 * YEAR, 0.7, _make_vec(2)),  # different scene
        ]
        pairs = find_scene_pairs(items, 2 * YEAR, 0.90, 10)
        assert len(pairs) == 0

    def test_each_photo_used_at_most_once(self):
        base = _make_vec(1)
        items = [
            ("a", 0.0, 0.9, base),
            ("b", 3 * YEAR, 0.8, _similar_vec(base, 0.005, seed=10)),
            ("c", 4 * YEAR, 0.7, _similar_vec(base, 0.008, seed=20)),
        ]
        pairs = find_scene_pairs(items, 2 * YEAR, 0.85, 10)
        # a matches both b and c, but each photo can only appear once
        assert len(pairs) == 1
        used = {pairs[0][0], pairs[0][1]}
        assert "a" in used

    def test_max_pairs_limit(self):
        pairs_data = []
        for i in range(10):
            v = _make_vec(i * 100)
            pairs_data.append((f"then_{i}", float(i) * DAY, 0.8, v))
            pairs_data.append((f"now_{i}", 5 * YEAR + float(i) * DAY, 0.7, _similar_vec(v, 0.005, seed=i)))
        pairs = find_scene_pairs(pairs_data, 2 * YEAR, 0.85, 3)
        assert len(pairs) <= 3

    def test_skips_items_without_embeddings(self):
        v1 = _make_vec(1)
        items = [
            ("a", 0.0, 0.8, v1),
            ("b", 3 * YEAR, 0.7, None),
            ("c", 3 * YEAR, 0.6, _similar_vec(v1, 0.005)),
        ]
        pairs = find_scene_pairs(items, 2 * YEAR, 0.85, 10)
        # b has no embedding, so the only possible pair is (a, c)
        assert all(p[0] != "b" and p[1] != "b" for p in pairs)

    def test_empty_input(self):
        assert find_scene_pairs([], 2 * YEAR, 0.90, 10) == []

    def test_single_item(self):
        assert find_scene_pairs(
            [("a", 0.0, 0.8, _make_vec(1))],
            2 * YEAR, 0.90, 10
        ) == []

    def test_then_is_always_older(self):
        v1 = _make_vec(1)
        v2 = _similar_vec(v1, noise=0.005)
        items = [
            ("newer", 5 * YEAR, 0.8, v1),
            ("older", 0.0, 0.7, v2),
        ]
        pairs = find_scene_pairs(items, 2 * YEAR, 0.85, 10)
        assert len(pairs) == 1
        assert pairs[0][0] == "older"
        assert pairs[0][1] == "newer"

"""Tests for near-duplicate detection inside a similar-photo group."""

from __future__ import annotations

import math
from typing import List

from app.services.redundant_pairs import find_redundant_pairs


def _vec(angle_deg: float) -> List[float]:
    """A 2-value unit vector at the given angle, so the cosine similarity
    between two synthetic 'embeddings' is exactly cos(Δangle)."""
    a = math.radians(angle_deg)
    return [math.cos(a), math.sin(a)]


def test_reports_pair_above_threshold():
    # 5° apart → cos 5° ≈ 0.9962, above a 0.97 threshold.
    pairs = find_redundant_pairs([("a", _vec(0)), ("b", _vec(5))], 0.97)
    assert len(pairs) == 1
    assert pairs[0][0] == "a"
    assert pairs[0][1] == "b"
    assert pairs[0][2] > 0.99


def test_ignores_pair_below_threshold():
    # 20° apart → cos 20° ≈ 0.9397, below 0.97.
    assert find_redundant_pairs([("a", _vec(0)), ("b", _vec(20))], 0.97) == []


def test_photos_without_embedding_never_form_a_pair():
    # A missing vector must not make a photo redundant with anything —
    # otherwise an unscored photo could be dropped from a pick set on no
    # evidence at all.
    pairs = find_redundant_pairs([("a", _vec(0)), ("b", None), ("c", None)], 0.97)
    assert pairs == []


def test_mixed_group_reports_only_the_redundant_pair():
    items = [("a", _vec(0)), ("b", _vec(2)), ("c", _vec(45))]
    pairs = find_redundant_pairs(items, 0.97)
    assert [(p[0], p[1]) for p in pairs] == [("a", "b")]


def test_all_pairs_reported_when_every_member_is_alike():
    items = [("a", _vec(0)), ("b", _vec(1)), ("c", _vec(2))]
    pairs = find_redundant_pairs(items, 0.97)
    assert {(p[0], p[1]) for p in pairs} == {("a", "b"), ("a", "c"), ("b", "c")}


def test_sorted_by_similarity_descending():
    # a–b (1° apart) is more redundant than a–c (4°), so it must come first.
    items = [("a", _vec(0)), ("b", _vec(1)), ("c", _vec(4))]
    pairs = find_redundant_pairs(items, 0.97)
    assert pairs[0][0] == "a" and pairs[0][1] == "b"
    assert pairs == sorted(pairs, key=lambda p: (-p[2], p[0], p[1]))


def test_degenerate_vector_is_skipped():
    assert find_redundant_pairs([("a", [0.0, 0.0]), ("b", _vec(0))], 0.97) == []


def test_group_smaller_than_two_yields_nothing():
    assert find_redundant_pairs([], 0.97) == []
    assert find_redundant_pairs([("a", _vec(0))], 0.97) == []


def test_threshold_of_one_only_matches_identical_vectors():
    items = [("a", _vec(0)), ("b", _vec(0)), ("c", _vec(3))]
    pairs = find_redundant_pairs(items, 1.0)
    assert [(p[0], p[1]) for p in pairs] == [("a", "b")]

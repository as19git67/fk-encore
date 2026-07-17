"""Tests for the quality/diversity/location-aware recap photo selection."""

from __future__ import annotations

import math
from typing import List, Optional, Sequence, Tuple

from app.services.diverse_select import _distribute_budget, select_diverse


def _vec(angle_deg: float) -> List[float]:
    """A 2-value unit vector at the given angle — handy for controlling the
    cosine similarity between synthetic 'embeddings' in tests."""
    a = math.radians(angle_deg)
    return [math.cos(a), math.sin(a)]


def item(
    pid: str,
    quality: float,
    cluster: int = 0,
    emb: Optional[Sequence[float]] = None,
) -> Tuple[str, float, int, Optional[Sequence[float]]]:
    return (pid, quality, cluster, emb)


class TestDistributeBudget:
    def test_spreads_one_per_cluster_before_seconds(self):
        # Three clusters, budget of 3 → one each.
        assert _distribute_budget({0: 10, 1: 10, 2: 10}, 3) == {0: 1, 1: 1, 2: 1}

    def test_tiny_budget_favours_the_biggest_clusters(self):
        # Budget of 2 across three clusters → the two largest get a slot.
        budget = _distribute_budget({0: 1, 1: 5, 2: 9}, 2)
        assert budget[2] == 1 and budget[1] == 1 and budget[0] == 0

    def test_never_exceeds_cluster_capacity(self):
        budget = _distribute_budget({0: 1, 1: 100}, 30)
        assert budget[0] == 1
        assert budget[1] == 29
        assert sum(budget.values()) == 30

    def test_budget_capped_at_total(self):
        budget = _distribute_budget({0: 2, 1: 2}, 10)
        assert sum(budget.values()) == 4


class TestSelectDiverse:
    def test_returns_all_when_count_exceeds_pool(self):
        items = [item("a", 1.0), item("b", 3.0), item("c", 2.0)]
        # Best-first ordering.
        assert select_diverse(items, 10, 0.82) == ["b", "c", "a"]

    def test_empty_pool(self):
        assert select_diverse([], 5, 0.82) == []

    def test_skips_near_duplicates_below_threshold(self):
        # Two nearly-identical high-quality shots plus a distinct third.
        items = [
            item("dup1", 0.99, 0, _vec(0)),
            item("dup2", 0.98, 0, _vec(1)),   # ~1° from dup1 → cosine ~0.9998
            item("distinct", 0.90, 0, _vec(90)),  # orthogonal → cosine 0
        ]
        chosen = select_diverse(items, 2, 0.95)
        assert "dup1" in chosen
        assert "distinct" in chosen
        assert "dup2" not in chosen

    def test_backfills_when_not_enough_diverse(self):
        # All three are near-identical; asking for 2 must still return 2.
        items = [
            item("a", 0.99, 0, _vec(0)),
            item("b", 0.98, 0, _vec(1)),
            item("c", 0.97, 0, _vec(2)),
        ]
        chosen = select_diverse(items, 2, 0.95)
        assert len(chosen) == 2
        assert chosen[0] == "a"  # best quality leads (cover)

    def test_spreads_across_location_clusters(self):
        # Cluster 0 has many great shots; cluster 1 has one mediocre shot.
        # A pure quality pick would ignore cluster 1 — the budget floor keeps it.
        items = [
            item("c0a", 0.99, 0, _vec(0)),
            item("c0b", 0.98, 0, _vec(90)),
            item("c0c", 0.97, 0, _vec(180)),
            item("c1", 0.50, 1, _vec(45)),
        ]
        chosen = select_diverse(items, 2, 0.82)
        assert "c1" in chosen  # geographic spread wins a slot for cluster 1

    def test_photos_without_embeddings_stay_eligible(self):
        items = [
            item("has", 0.99, 0, _vec(0)),
            item("none", 0.98, 0, None),
        ]
        chosen = select_diverse(items, 2, 0.82)
        assert set(chosen) == {"has", "none"}

    def test_cover_is_highest_quality(self):
        items = [
            item("low", 0.10, 0, _vec(0)),
            item("high", 0.99, 1, _vec(90)),
            item("mid", 0.50, 2, _vec(180)),
        ]
        chosen = select_diverse(items, 3, 0.82)
        assert chosen[0] == "high"

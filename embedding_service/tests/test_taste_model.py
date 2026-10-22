"""The personal taste model: pairs, the fit, out-of-fold scores, the stored model."""

import os
import sys
import time

import numpy as np
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.services import taste_model as tm  # noqa: E402


def _library(n_groups=200, size=4, dims=32, base_signal=0.0, seed=0):
    """Groups whose kept photo leans along one hidden direction of the vector space.

    `base_signal` mixes the same preference into the formula score; at 0 the
    formula knows nothing of it.
    """
    rng = np.random.default_rng(seed)
    taste = rng.normal(size=dims)
    taste /= np.linalg.norm(taste)
    vectors = {}
    groups = []
    for g in range(n_groups):
        centre = rng.normal(size=dims)
        photos = []
        values = []
        for i in range(size):
            pid = f"{g}-{i}"
            v = centre + rng.normal(scale=0.3, size=dims)
            vectors[pid] = v
            values.append((pid, float(v @ taste) + rng.normal(scale=0.05)))
        best = max(values, key=lambda t: t[1])[0]
        for pid, value in values:
            base = 0.5 + base_signal * value + rng.normal(scale=0.1)
            photos.append(tm.GroupPhoto(photo_id=pid, kept=pid == best, base=base))
        groups.append(tm.Group(group_id=g + 1, photos=photos))
    return groups, vectors


def _hits(groups, score):
    hits = 0
    for g in groups:
        top = max(g.photos, key=lambda p: (score(p), -int(p.photo_id.split("-")[1])))
        hits += top.kept
    return hits


def test_usable_groups_need_a_decision_and_every_vector():
    vectors = {"a": np.zeros(2), "b": np.zeros(2), "c": np.zeros(2)}
    decided = tm.Group(3, [tm.GroupPhoto("a", True, 0.5), tm.GroupPhoto("b", False, 0.5)])
    all_kept = tm.Group(1, [tm.GroupPhoto("a", True, 0.5), tm.GroupPhoto("c", True, 0.5)])
    no_vector = tm.Group(2, [tm.GroupPhoto("a", True, 0.5), tm.GroupPhoto("x", False, 0.5)])
    other = tm.Group(0, [tm.GroupPhoto("c", True, 0.5), tm.GroupPhoto("b", False, 0.5)])
    assert [g.group_id for g in tm.usable_groups([decided, all_kept, no_vector, other], vectors)] == [0, 3]


def test_folds_follow_the_group_order_like_the_app():
    groups = [tm.Group(i, []) for i in range(7)]
    folds = tm.folds_of(groups, 3)
    assert [[g.group_id for g in held] for _, held in folds] == [[0, 3, 6], [1, 4], [2, 5]]
    assert all(len(train) + len(held) == 7 for train, held in folds)


def test_each_group_weighs_the_same_whatever_its_size():
    vectors = {k: np.array([float(i)]) for i, k in enumerate("abcde")}
    big = tm.Group(1, [tm.GroupPhoto("a", True, 0)] + [tm.GroupPhoto(k, False, 0) for k in "bcd"])
    small = tm.Group(2, [tm.GroupPhoto("e", True, 0), tm.GroupPhoto("a", False, 0)])
    _, sw = tm._pairs([big, small], vectors, with_base=False)
    assert sw.tolist() == pytest.approx([1 / 3] * 3 + [1.0])


def test_out_of_fold_taste_finds_what_the_formula_misses():
    groups, vectors = _library(base_signal=0.0)
    combined, taste = tm.out_of_fold(groups, vectors)
    base_hits = _hits(groups, lambda p: p.base)
    comb_hits = _hits(groups, lambda p: combined[p.photo_id])
    taste_hits = _hits(groups, lambda p: taste[p.photo_id])
    assert base_hits < 90  # about one in four by chance
    assert comb_hits > 150
    assert taste_hits > 150


def test_model_keeps_the_formula_when_it_carries_the_preference():
    groups, vectors = _library(base_signal=1.0, seed=3)
    model = tm.train(groups, vectors)
    assert model.base_weight > 0
    assert model.weights.shape == (32,)
    assert model.groups == 200
    assert model.pairs == 200 * 3
    assert model.ridge_lambda in tm.LAMBDAS
    assert 0.5 < model.train_pair_accuracy <= 1.0
    # The bonus the app adds is centred on the training photos.
    values = [vectors[p.photo_id] @ model.weights - model.offset for g in groups for p in g.photos]
    assert abs(float(np.mean(values))) < 1e-9


def test_nothing_to_learn_from_refused():
    with pytest.raises(tm.TooFewGroupsError):
        tm.train([], {})


def test_full_size_replay_is_quick_enough():
    """About the household's numbers: 1000 groups of four photos, 1024-dim vectors."""
    groups, vectors = _library(n_groups=1000, dims=1024, seed=7)
    started = time.perf_counter()
    combined, _ = tm.out_of_fold(groups, vectors)
    assert len(combined) == 4000
    assert time.perf_counter() - started < 120

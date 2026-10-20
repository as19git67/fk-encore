"""The provisional aesthetic head: ridge fit, the gate against zero-shot, persistence."""

import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.services import aesthetic_head as ah  # noqa: E402


def _data(n=1000, dims=64, noise=0.02, seed=0):
    rng = np.random.default_rng(seed)
    x = rng.normal(size=(n, dims))
    w = rng.normal(size=dims) * 0.05
    y = np.clip(0.5 + x @ w + rng.normal(scale=noise, size=n), 0, 1)
    return x, y


def test_spearman_handles_ties_and_constants():
    assert ah.spearman([1, 2, 3, 4], [10, 20, 30, 40]) == pytest.approx(1.0)
    assert ah.spearman([1, 2, 3, 4], [4, 3, 2, 1]) == pytest.approx(-1.0)
    assert ah.spearman([1, 1, 2, 2], [1, 1, 2, 2]) == pytest.approx(1.0)
    assert ah.spearman([1, 1, 1], [1, 2, 3]) == 0.0


def test_head_that_learns_the_signal_beats_noise_and_is_active():
    x, y = _data()
    zero_shot = np.random.default_rng(5).uniform(size=len(y))
    head = ah.train(x, y, zero_shot)
    r = head.report
    assert r.active
    assert r.spearman_head > 0.9
    assert abs(r.spearman_zero_shot) < 0.2
    assert r.train + r.validation + r.test == r.samples == 1000
    assert r.ridge_lambda in ah.RIDGE_LAMBDAS


def test_head_worse_than_zero_shot_stays_inactive():
    x, _ = _data()
    y = np.random.default_rng(9).uniform(size=len(x))  # nothing to learn from x
    head = ah.train(x, y, zero_shot=y)  # the prompts happen to be perfect
    assert not head.report.active


def test_too_few_samples_refused():
    x, y = _data(n=ah.MIN_SAMPLES - 1)
    with pytest.raises(ah.TooFewSamplesError):
        ah.train(x, y, y)


def test_predictions_are_clipped_to_unit_range():
    x, y = _data()
    head = ah.train(x, y, y)
    out = head.predict(x * 100)
    assert out.min() >= 0.0 and out.max() <= 1.0
    assert head.predict(x[0]).shape == (1,)


def test_save_and_load_round_trip(tmp_path):
    x, y = _data()
    head = ah.train(x, y, np.zeros(len(y)))
    path = tmp_path / "head.npz"
    ah.save(head, path)
    ah._cached = None
    loaded = ah.load(path)
    assert loaded is not None
    assert loaded.report == head.report
    np.testing.assert_allclose(loaded.predict(x[:5]), head.predict(x[:5]))
    assert ah.active_head(path) is not None


def test_missing_or_unreadable_file_means_no_head(tmp_path):
    assert ah.load(tmp_path / "none.npz") is None
    bad = tmp_path / "bad.npz"
    bad.write_bytes(b"not a numpy archive")
    assert ah.load(bad) is None

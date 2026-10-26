"""Zero-shot subjects: label directions and the softmax over them."""

import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.services import zero_shot as zs  # noqa: E402


def test_each_photo_leans_to_the_label_it_points_at():
    labels = np.eye(3)
    images = np.array([[0.9, 0.1, 0.0], [0.0, 0.2, 0.8], [0.3, 0.3, 0.3]])
    p = zs.subject_probabilities(images, labels)
    assert p.shape == (3, 3)
    assert np.allclose(p.sum(axis=1), 1.0)
    assert p[0].argmax() == 0
    assert p[1].argmax() == 2
    # A photo at equal angles to all labels gets equal shares.
    assert np.allclose(p[2], 1 / 3)


def test_label_vectors_average_prompts_and_cache_them():
    calls = []

    def embed(text):
        calls.append(text)
        return {"a": [1.0, 0.0], "b": [0.0, 1.0], "c": [1.0, 1.0]}[text]

    zs._text_cache.clear()
    v = zs.label_vectors(embed, [["a", "b"], ["c"]])
    assert np.allclose(v[0], [np.sqrt(0.5), np.sqrt(0.5)])
    assert np.allclose(np.linalg.norm(v, axis=1), 1.0)
    zs.label_vectors(embed, [["a"]])
    assert calls == ["a", "b", "c"]


def test_mismatched_sizes_are_refused():
    with pytest.raises(ValueError):
        zs.subject_probabilities(np.ones((2, 3)), np.ones((2, 4)))

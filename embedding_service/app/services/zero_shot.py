"""Zero-shot subjects of photos from their stored CLIP vectors.

The photo book (documentation/plans/fotobuch.md, stage 4) weights photos by
what they show — people, landscape, nature, buildings. Each subject is a few
text prompts; their CLIP text vectors are averaged into one direction, and a
photo's share of each subject is the softmax over the subjects of its cosine
to each direction, scaled like CLIP's own logits. One subject should always
be a catch-all ("something else"), so a photo of a plate of food does not
have to pick between a mountain and a church.

Pure numpy here; the endpoint embeds the prompts and reads the vectors.
"""

from __future__ import annotations

from typing import Callable, Dict, List, Sequence

import numpy as np

#: CLIP's learned logit scale is about 100; softmax at that temperature is what the model was trained for.
LOGIT_SCALE = 100.0

_text_cache: Dict[str, np.ndarray] = {}


def _normalise(v: np.ndarray) -> np.ndarray:
    n = np.linalg.norm(v, axis=-1, keepdims=True)
    n[n == 0] = 1.0
    return v / n


def label_vectors(embed_text: Callable[[str], Sequence[float]], labels: List[List[str]]) -> np.ndarray:
    """One unit direction per label: the mean of its prompts' text vectors."""
    rows = []
    for prompts in labels:
        vecs = []
        for p in prompts:
            if p not in _text_cache:
                _text_cache[p] = _normalise(np.asarray(embed_text(p), dtype=np.float64))
            vecs.append(_text_cache[p])
        rows.append(_normalise(np.mean(np.stack(vecs), axis=0)))
    return np.stack(rows)


def subject_probabilities(images: np.ndarray, labels: np.ndarray, logit_scale: float = LOGIT_SCALE) -> np.ndarray:
    """(photos × labels) softmax of the scaled cosines; each row sums to 1."""
    if images.ndim != 2 or labels.ndim != 2 or images.shape[1] != labels.shape[1]:
        raise ValueError(f"vector sizes differ: images {images.shape}, labels {labels.shape}")
    logits = logit_scale * (_normalise(images) @ labels.T)
    logits -= logits.max(axis=1, keepdims=True)
    e = np.exp(logits)
    return e / e.sum(axis=1, keepdims=True)

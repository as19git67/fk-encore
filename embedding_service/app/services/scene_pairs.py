"""Find visually similar photo pairs separated by large time gaps.

Given a set of photo embeddings with timestamps, identifies pairs where
the same scene/object/perspective was photographed years apart — the
"Damals & heute" (then & now) recap concept.
"""

from __future__ import annotations

from typing import List, Optional, Sequence, Tuple

import numpy as np


def find_scene_pairs(
    items: Sequence[Tuple[str, float, float, Optional[List[float]]]],
    min_time_gap_seconds: float,
    similarity_threshold: float,
    max_pairs: int,
) -> List[Tuple[str, str, float, int]]:
    """Return pairs of photos showing the same scene across a time gap.

    Parameters
    ----------
    items : sequence of (photo_id, timestamp_epoch, quality, embedding_or_None)
        Candidate photos with DINOv2 embeddings.
    min_time_gap_seconds : float
        Minimum time gap between pair members.
    similarity_threshold : float
        Minimum cosine similarity to consider two photos a scene match.
    max_pairs : int
        Maximum number of pairs to return.

    Returns
    -------
    list of (photo_id_then, photo_id_now, similarity, time_gap_days)
        Best pairs sorted by similarity descending. ``then`` is always
        the older photo, ``now`` the newer one.
    """
    valid = [
        (pid, ts, q, emb)
        for pid, ts, q, emb in items
        if emb is not None and len(emb) > 0
    ]
    n = len(valid)
    if n < 2:
        return []

    ids = [v[0] for v in valid]
    timestamps = np.asarray([v[1] for v in valid], dtype=np.float64)
    qualities = np.asarray([v[2] for v in valid], dtype=np.float64)
    embeddings = np.asarray([v[3] for v in valid], dtype=np.float32)

    norms = np.linalg.norm(embeddings, axis=1, keepdims=True)
    np.maximum(norms, 1e-12, out=norms)
    embeddings = embeddings / norms

    # Cap the matrix size to prevent OOM on very large libraries.
    # Sample the highest-quality photos if the candidate set is too large.
    MAX_MATRIX_SIZE = 2000
    if n > MAX_MATRIX_SIZE:
        top_indices = np.argsort(-qualities)[:MAX_MATRIX_SIZE]
        top_indices.sort()
        ids = [ids[i] for i in top_indices]
        timestamps = timestamps[top_indices]
        qualities = qualities[top_indices]
        embeddings = embeddings[top_indices]
        n = MAX_MATRIX_SIZE

    sim_matrix = embeddings @ embeddings.T

    # Build time-gap matrix (absolute difference in seconds)
    time_diffs = np.abs(timestamps[:, None] - timestamps[None, :])

    # Mask: only upper triangle (avoid duplicate pairs), sufficient time gap,
    # and similarity above threshold.
    mask = np.triu(np.ones((n, n), dtype=bool), k=1)
    mask &= time_diffs >= min_time_gap_seconds
    mask &= sim_matrix >= similarity_threshold

    if not np.any(mask):
        return []

    # Extract valid pairs, sort by similarity descending
    rows, cols = np.nonzero(mask)
    sims = sim_matrix[rows, cols]
    order = np.argsort(-sims)

    used = set()
    pairs: List[Tuple[str, str, float, int]] = []
    for idx in order:
        if len(pairs) >= max_pairs:
            break
        i, j = int(rows[idx]), int(cols[idx])
        if i in used or j in used:
            continue
        used.add(i)
        used.add(j)
        # Older photo is "then", newer is "now"
        if timestamps[i] <= timestamps[j]:
            then_id, now_id = ids[i], ids[j]
        else:
            then_id, now_id = ids[j], ids[i]
        gap_days = int(abs(timestamps[i] - timestamps[j]) / 86400)
        pairs.append((then_id, now_id, float(sims[idx]), gap_days))

    return pairs

"""Windowed similar-photo grouping for DINOv2 embeddings.

Main app used to do this work in Node.js: fetch every embedding over HTTP,
then run an O(N²) pairwise cosine-similarity loop in plain JS. With 45 k
photos and a 10-minute window that blocked the Node event loop for seconds
at a time — gallery requests issued during the regroup simply hung.

Doing the same work here keeps all vector math inside this service: numpy
uses SIMD for the matrix multiplications, embeddings never leave the service
over the wire, and the main app only receives compact group structures.
"""

from __future__ import annotations

from typing import List, Sequence, Tuple

import numpy as np


def _union_find(n: int, pairs: Sequence[Tuple[int, int]]) -> List[int]:
    parent = list(range(n))
    rank = [0] * n

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra == rb:
            return
        if rank[ra] < rank[rb]:
            parent[ra] = rb
        elif rank[ra] > rank[rb]:
            parent[rb] = ra
        else:
            parent[rb] = ra
            rank[ra] += 1

    for a, b in pairs:
        union(a, b)
    return [find(i) for i in range(n)]


def find_similar_groups(
    rows: Sequence[Tuple[str, float, List[float]]],
    threshold: float,
    time_window_seconds: float,
) -> List[Tuple[str, List[str]]]:
    """Return groups of visually-similar photos captured close in time.

    `rows` is expected ordered by timestamp ascending — the windowed scan
    relies on that to stop early once it leaves the window.

    Returns a list of ``(cover_photo_id, ranked_member_ids)`` tuples, where
    the cover is the medoid (member with highest mean cosine similarity to
    the rest of its group) and ranked members include the cover at index 0.
    Singleton groups are filtered out.
    """
    n = len(rows)
    if n < 2:
        return []

    ids = [r[0] for r in rows]
    timestamps = np.asarray([r[1] for r in rows], dtype=np.float64)

    # Stack embeddings into an (N, 768) matrix, unit-normalize once so every
    # later inner product is a cosine similarity. Float32 keeps the array half
    # the size of Python-list embeddings and plays nicely with SIMD.
    embeddings = np.asarray([r[2] for r in rows], dtype=np.float32)
    norms = np.linalg.norm(embeddings, axis=1, keepdims=True)
    # Avoid division by zero for degenerate vectors (they won't pair with
    # anything above the threshold either way, but we still need to keep the
    # row so indices line up).
    np.maximum(norms, 1e-12, out=norms)
    embeddings = embeddings / norms

    # Sliding-window pairwise scan. For each anchor `i`, find the rightmost
    # `j_end` that is still within the time window (binary search via
    # searchsorted), then matmul the anchor against the slice in one go.
    # That replaces the inner Python loop with a single BLAS call per anchor.
    pairs: List[Tuple[int, int]] = []
    j_ends = np.searchsorted(timestamps, timestamps + time_window_seconds, side="right")

    for i in range(n - 1):
        j_end = int(j_ends[i])
        if j_end <= i + 1:
            continue
        sims = embeddings[i + 1 : j_end] @ embeddings[i]
        hits = np.nonzero(sims >= threshold)[0]
        for h in hits:
            pairs.append((i, i + 1 + int(h)))

    if not pairs:
        return []

    components = _union_find(n, pairs)
    buckets: dict[int, List[int]] = {}
    for idx, root in enumerate(components):
        buckets.setdefault(root, []).append(idx)

    groups: List[Tuple[str, List[str]]] = []
    for members in buckets.values():
        if len(members) < 2:
            continue
        sub = embeddings[members]
        # (k, k) cosine matrix; diagonal is 1. Row-sum - 1 over (k-1) gives
        # mean similarity to the rest — medoid = argmax.
        sim_matrix = sub @ sub.T
        mean_sim = (sim_matrix.sum(axis=1) - 1.0) / (len(members) - 1)
        center_local = int(np.argmax(mean_sim))
        center_global = members[center_local]

        sims_to_center = sim_matrix[center_local]
        order = np.argsort(-sims_to_center)
        ranked_ids = [ids[members[int(idx)]] for idx in order]
        groups.append((ids[center_global], ranked_ids))

    return groups

"""Near-duplicate detection *within* an already-formed similar-photo group.

The main app's auto-pick (``photo/group-auto-pick.ts``) may select more than
one photo per group: the top-scored photo always wins, and every sibling
scoring at least ``MULTI_PICK_THRESHOLD`` of that top score joins it. On a
burst of near-identical frames that rule happily keeps two shots of the *same*
moment, because near-identical frames also score near-identically — the pick
set had no notion of two picks being redundant with one another.

This module supplies the missing signal: for one group, which member pairs are
so alike that keeping both adds nothing. Every member of a similar group is by
construction similar to every other one (that is why they were grouped), so the
threshold here sits far above the grouping threshold and describes "the same
shot again", not "the same subject".

It lives in the embedding service for the same reason as ``diverse_select``:
the DINOv2 vectors never cross the HTTP boundary, and numpy does the small
pairwise matmul on SIMD-backed BLAS. Groups are tiny (a handful of photos), so
the exact O(n²) is cheaper than any approximation.
"""

from __future__ import annotations

from typing import List, Optional, Sequence, Tuple

import numpy as np

# One item per group member: (photo_id, dino_embedding). The embedding may be
# None — a photo whose vector has not been computed yet simply takes part in no
# pair, so a missing vector can never cause a photo to be dropped from a pick.
PairItem = Tuple[str, Optional[Sequence[float]]]


def find_redundant_pairs(
    items: Sequence[PairItem],
    min_similarity: float,
) -> List[Tuple[str, str, float]]:
    """Return every member pair with cosine similarity >= ``min_similarity``.

    Output is sorted by similarity descending, then by the id pair, so the
    caller sees the most redundant pair first and the result is deterministic.
    Pairs are emitted once, in the members' input order (a before b).
    """
    n = len(items)
    if n < 2:
        return []

    # Unit-normalize once so every later inner product is a cosine similarity.
    # A missing or degenerate vector becomes None and is skipped entirely.
    index: List[int] = []
    vecs: List[np.ndarray] = []
    for i, (_pid, emb) in enumerate(items):
        if emb is None:
            continue
        v = np.asarray(emb, dtype=np.float32)
        norm = float(np.linalg.norm(v))
        if norm <= 1e-12:
            continue
        index.append(i)
        vecs.append(v / norm)

    if len(vecs) < 2:
        return []

    matrix = np.vstack(vecs)
    sims = matrix @ matrix.T

    pairs: List[Tuple[str, str, float]] = []
    for a in range(len(index)):
        for b in range(a + 1, len(index)):
            similarity = float(sims[a, b])
            if similarity >= min_similarity:
                pairs.append((items[index[a]][0], items[index[b]][0], similarity))

    pairs.sort(key=lambda p: (-p[2], p[0], p[1]))
    return pairs

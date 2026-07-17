"""Quality-weighted, location-aware diverse photo selection for recaps.

The main app builds photo recaps (on-this-day, trips, places, …). Its old
curation kept the highest-quality photos and collapsed only bursts that were
close together *in time*. That still let visually near-identical shots pile up
(five almost-equal sunsets across a trip) and gave no weight to *where* the
photos were taken.

This module picks up to ``count`` photos that are:

  * high quality (AI quality score, descending),
  * visually diverse (DINOv2 cosine similarity below a threshold), and
  * spread across the location clusters the caller assigns — every distinct
    spot contributes at least one photo before any single spot gets a second.

It intentionally lives in the embedding service: the DINOv2 vectors never
have to cross the HTTP boundary, and numpy runs the small pairwise math on
SIMD-backed BLAS. The candidate set per recap is bounded (the caller pre-trims
to its top-N by quality), so the O(n·k) greedy stays cheap.
"""

from __future__ import annotations

from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np

# One item per candidate photo: (photo_id, quality, cluster, dino_embedding).
# ``dino_embedding`` may be None — photos without a stored vector stay eligible
# and are simply never blocked by (nor block) the similarity threshold.
DiverseItem = Tuple[str, float, int, Optional[Sequence[float]]]


def _distribute_budget(cluster_sizes: Dict[int, int], count: int) -> Dict[int, int]:
    """Split ``count`` picks across clusters proportional to their size.

    Every non-empty cluster receives at least one slot while the budget allows,
    so geographically distinct spots each contribute a photo before any single
    spot gets a second. Never allocates more slots than a cluster can fill.
    """
    total = sum(cluster_sizes.values())
    target = min(count, total)
    clusters = sorted(cluster_sizes)
    budget = {c: 0 for c in clusters}
    if target <= 0:
        return budget

    # Phase 1 — floor of one per cluster, biggest clusters first, until the
    # target is spent (covers the case target < number of clusters).
    for c in sorted(clusters, key=lambda c: (-cluster_sizes[c], c)):
        if sum(budget.values()) >= target:
            break
        if cluster_sizes[c] > 0:
            budget[c] = 1

    # Phase 2 — hand out the remaining slots by each cluster's leftover
    # capacity (largest-remainder method), never exceeding capacity.
    remaining = target - sum(budget.values())
    if remaining <= 0:
        return budget

    capacity = {c: cluster_sizes[c] - budget[c] for c in clusters}
    cap_total = sum(capacity.values())
    if cap_total <= 0:
        return budget

    quotas = {c: remaining * capacity[c] / cap_total for c in clusters}
    for c in clusters:
        give = min(int(quotas[c]), capacity[c])
        budget[c] += give
        capacity[c] -= give

    leftover = target - sum(budget.values())
    order = sorted(
        clusters,
        key=lambda c: (-(quotas[c] - int(quotas[c])), -capacity[c], c),
    )
    i = 0
    while leftover > 0 and any(capacity[c] > 0 for c in clusters):
        c = order[i % len(order)]
        if capacity[c] > 0:
            budget[c] += 1
            capacity[c] -= 1
            leftover -= 1
        i += 1
    return budget


def select_diverse(
    items: Sequence[DiverseItem],
    count: int,
    similarity_threshold: float,
) -> List[str]:
    """Return up to ``count`` photo ids, best-first (index 0 is the cover).

    Selection is quality-ordered but skips a candidate whose maximum cosine
    similarity to an already-chosen photo reaches ``similarity_threshold``,
    subject to a per-cluster budget so picks stay geographically spread. If the
    threshold or the budgets leave us short — not enough dissimilar photos — we
    top up by quality so we never return fewer than ``min(count, len(items))``.
    """
    n = len(items)
    if n == 0 or count <= 0:
        return []
    if count >= n:
        return [it[0] for it in sorted(items, key=lambda it: -it[1])]

    # Unit-normalize the available embeddings once so every later inner product
    # is a cosine similarity. A missing / degenerate vector becomes None.
    vecs: List[Optional[np.ndarray]] = []
    for _pid, _q, _c, emb in items:
        if emb is None:
            vecs.append(None)
            continue
        v = np.asarray(emb, dtype=np.float32)
        norm = float(np.linalg.norm(v))
        vecs.append(v / norm if norm > 1e-12 else None)

    cluster_sizes: Dict[int, int] = {}
    for _pid, _q, c, _e in items:
        cluster_sizes[c] = cluster_sizes.get(c, 0) + 1
    budget = _distribute_budget(cluster_sizes, count)

    # Candidate order: quality descending, original index as a stable tiebreak.
    order = sorted(range(n), key=lambda i: (-items[i][1], i))

    selected: List[int] = []
    selected_vecs: List[np.ndarray] = []
    taken_per_cluster: Dict[int, int] = {c: 0 for c in cluster_sizes}

    def is_diverse(i: int) -> bool:
        v = vecs[i]
        if v is None or not selected_vecs:
            return True
        best = max(float(v @ sv) for sv in selected_vecs)
        return best < similarity_threshold

    # Main pass — honour per-cluster budget and the diversity threshold.
    for i in order:
        if len(selected) >= count:
            break
        c = items[i][2]
        if taken_per_cluster[c] >= budget.get(c, 0):
            continue
        if is_diverse(i):
            selected.append(i)
            if vecs[i] is not None:
                selected_vecs.append(vecs[i])
            taken_per_cluster[c] += 1

    # Backfill — if diversity / budgets left us short, top up by quality,
    # ignoring both, so the recap still reaches its target photo count.
    if len(selected) < count:
        chosen = set(selected)
        for i in order:
            if len(selected) >= count:
                break
            if i in chosen:
                continue
            selected.append(i)
            chosen.add(i)

    # Best-first so the caller can use index 0 as the cover photo.
    selected.sort(key=lambda i: (-items[i][1], i))
    return [items[i][0] for i in selected]

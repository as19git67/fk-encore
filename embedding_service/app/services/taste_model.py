"""Personal taste from the user's own picks (foto-aesthetik, stage 7).

The auto-pick adds up a handful of measured signals with weights. Fitting
those weights to the user's reviews tops out where the signals stop: none
of them says "people", "warm light" or "this framing". The CLIP ViT-H/14
vector this service stores for every photo does carry that, so a linear
model on it learns what the user keeps.

Every reviewed group in which the user kept one photo and hid another is a
set of pairs "kept over hidden". The model is a pairwise logistic
regression on the differences of

    [formula score, CLIP vector]

so it learns how much of today's formula to keep (`base_weight`) and what
in the vector to add. The vector part is L2-penalised; the strength is
chosen on a quarter of the training groups by pairwise log-loss. Each
group's pairs share one unit of weight, so a group with nine hidden photos
counts as much as one with a single hidden photo.

The service holds no model. The app sends the groups and gets back
out-of-fold scores (`replay`), a fitted model (`train`), or the raw taste
values of stored vectors under a model it sends (`score`).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np

#: The app stores this next to the fitted weights.
MODEL_VERSION = "clip_taste_v1"

#: Candidate L2 strengths, in units of the averaged pair loss after scaling.
LAMBDAS = (0.01, 0.1, 1.0, 10.0)

#: Folds of the replay, by group; the app counts hits over them.
FOLDS = 5

#: Practically free: only there to keep the Newton system regular.
BASE_PENALTY = 1e-6

NEWTON_ITERS = 25


@dataclass
class GroupPhoto:
    photo_id: str
    kept: bool
    base: float


@dataclass
class Group:
    group_id: int
    photos: List[GroupPhoto]


@dataclass
class TasteModel:
    #: Multiplier of the formula score; the app needs it positive.
    base_weight: float
    #: Multipliers of the raw CLIP vector.
    weights: np.ndarray
    #: Mean of `weights · vector` over the training photos.
    offset: float
    ridge_lambda: float
    groups: int
    pairs: int
    #: Share of training pairs the model orders the way the user did.
    train_pair_accuracy: float


class TooFewGroupsError(ValueError):
    pass


def usable_groups(groups: Sequence[Group], vectors: Dict[str, np.ndarray]) -> List[Group]:
    """Groups with a kept and a hidden photo whose photos all have a vector, by id."""
    out = []
    for g in groups:
        if not all(p.photo_id in vectors for p in g.photos):
            continue
        if any(p.kept for p in g.photos) and any(not p.kept for p in g.photos):
            out.append(g)
    return sorted(out, key=lambda g: g.group_id)


def folds_of(groups: Sequence[Group], k: int = FOLDS) -> List[Tuple[List[Group], List[Group]]]:
    """(train, held) per fold: group i goes to fold i % k, as in the app's replays."""
    k = min(k, len(groups))
    return [
        ([g for i, g in enumerate(groups) if i % k != f], [g for i, g in enumerate(groups) if i % k == f])
        for f in range(k)
    ]


def _pairs(
    groups: Sequence[Group], vectors: Dict[str, np.ndarray], with_base: bool
) -> Tuple[np.ndarray, np.ndarray]:
    """Rows `features(kept) - features(hidden)` and their weights (each group sums to 1)."""
    rows: List[np.ndarray] = []
    weights: List[float] = []
    for g in groups:
        kept = [p for p in g.photos if p.kept]
        hidden = [p for p in g.photos if not p.kept]
        n = len(kept) * len(hidden)
        for a in kept:
            for b in hidden:
                diff = vectors[a.photo_id] - vectors[b.photo_id]
                rows.append(np.concatenate([[a.base - b.base], diff]) if with_base else diff)
                weights.append(1.0 / n)
    if not rows:
        return np.zeros((0, 0)), np.zeros(0)
    return np.vstack(rows), np.asarray(weights)


def _sigmoid(z: np.ndarray) -> np.ndarray:
    return 0.5 * (1.0 + np.tanh(0.5 * z))


def _fit_logistic(
    x: np.ndarray, sw: np.ndarray, penalty: np.ndarray, init: Optional[np.ndarray] = None
) -> np.ndarray:
    """Weighted logistic regression without intercept (all labels 1), Newton steps.

    Minimises  sum(sw * log(1 + exp(-x w))) / sum(sw) + 0.5 * sum(penalty * w**2).
    """
    sw = sw / sw.sum()

    def objective(w: np.ndarray) -> float:
        return float(np.sum(sw * np.logaddexp(0.0, -(x @ w)))) + 0.5 * float(np.sum(penalty * w * w))

    w = np.zeros(x.shape[1]) if init is None else init.copy()
    current = objective(w)
    for _ in range(NEWTON_ITERS):
        p = _sigmoid(x @ w)
        grad = -(x.T @ (sw * (1.0 - p))) + penalty * w
        h = (x * (sw * p * (1.0 - p))[:, None]).T @ x
        h[np.diag_indices_from(h)] += penalty
        step = np.linalg.solve(h, grad)
        # Halve the step until the objective drops; a full Newton step can overshoot.
        t = 1.0
        while t > 1e-4:
            candidate = w - t * step
            value = objective(candidate)
            if value <= current:
                break
            t *= 0.5
        else:
            break
        w, current = candidate, value
        if np.max(np.abs(t * step)) < 1e-7:
            break
    return w


def _log_loss(x: np.ndarray, sw: np.ndarray, w: np.ndarray) -> float:
    z = x @ w
    return float(np.sum(sw * np.logaddexp(0.0, -z)) / sw.sum())


@dataclass
class _Scaled:
    """Column scaling so one penalty fits both blocks: mean squared row part = 1."""

    base: float
    vec: float

    @staticmethod
    def of(x: np.ndarray, with_base: bool) -> "_Scaled":
        vec_part = x[:, 1:] if with_base else x
        vec = float(np.sqrt(np.mean(np.sum(vec_part ** 2, axis=1)))) or 1.0
        base = (float(np.sqrt(np.mean(x[:, 0] ** 2))) or 1.0) if with_base else 1.0
        return _Scaled(base=base, vec=vec)

    def apply(self, x: np.ndarray, with_base: bool) -> np.ndarray:
        if not with_base:
            return x / self.vec
        out = x.copy()
        out[:, 0] /= self.base
        out[:, 1:] /= self.vec
        return out

    def unscale(self, w: np.ndarray, with_base: bool) -> np.ndarray:
        if not with_base:
            return w / self.vec
        out = w.copy()
        out[0] /= self.base
        out[1:] /= self.vec
        return out


def _penalty(lam: float, dims: int, with_base: bool) -> np.ndarray:
    pen = np.full(dims, lam)
    if with_base:
        pen[0] = BASE_PENALTY
    return pen


def fit(
    groups: Sequence[Group], vectors: Dict[str, np.ndarray], with_base: bool = True
) -> Tuple[np.ndarray, float, int, float]:
    """Weights on the raw features, the chosen strength, the pair count, the training pair accuracy.

    The strength comes from a quarter of the groups held back (every fourth
    by id); the final fit sees all of them.
    """
    x, sw = _pairs(groups, vectors, with_base)
    if len(x) == 0:
        raise TooFewGroupsError("Keine Paare aus behaltenen und versteckten Fotos")
    scale = _Scaled.of(x, with_base)
    dims = x.shape[1]

    lam = LAMBDAS[len(LAMBDAS) // 2]
    val = [g for i, g in enumerate(groups) if i % 4 == 3]
    train = [g for i, g in enumerate(groups) if i % 4 != 3]
    if val and train:
        xt, swt = _pairs(train, vectors, with_base)
        xv, swv = _pairs(val, vectors, with_base)
        xt, xv = scale.apply(xt, with_base), scale.apply(xv, with_base)
        best: Optional[Tuple[float, float]] = None
        w = None
        # Strongest first: each fit starts from the last, so Newton needs few steps.
        for cand in sorted(LAMBDAS, reverse=True):
            w = _fit_logistic(xt, swt, _penalty(cand, dims, with_base), init=w)
            loss = _log_loss(xv, swv, w)
            if best is None or loss < best[0] - 1e-9:
                best = (loss, cand)
        lam = best[1]

    xs = scale.apply(x, with_base)
    w = _fit_logistic(xs, sw, _penalty(lam, dims, with_base))
    accuracy = float(np.sum(sw * (xs @ w > 0)) / sw.sum())
    return scale.unscale(w, with_base), lam, len(x), accuracy


def _score(groups: Sequence[Group], vectors: Dict[str, np.ndarray], w: np.ndarray, with_base: bool) -> Dict[str, float]:
    out = {}
    for g in groups:
        for p in g.photos:
            v = vectors[p.photo_id]
            out[p.photo_id] = float(w[0] * p.base + v @ w[1:]) if with_base else float(v @ w)
    return out


def out_of_fold(
    groups: Sequence[Group], vectors: Dict[str, np.ndarray], k: int = FOLDS
) -> Tuple[Dict[str, float], Dict[str, float]]:
    """Per photo: the combined and the taste-only score of a model fitted without its group."""
    combined: Dict[str, float] = {}
    taste: Dict[str, float] = {}
    for train, held in folds_of(groups, k):
        if not train:
            continue
        w_comb, *_ = fit(train, vectors, with_base=True)
        w_taste, *_ = fit(train, vectors, with_base=False)
        combined.update(_score(held, vectors, w_comb, with_base=True))
        taste.update(_score(held, vectors, w_taste, with_base=False))
    return combined, taste


def train(groups: Sequence[Group], vectors: Dict[str, np.ndarray]) -> TasteModel:
    """The model the app stores: fitted on every usable group."""
    if not groups:
        raise TooFewGroupsError("Keine entschiedene Gruppe mit CLIP-Vektoren")
    w, lam, pairs, accuracy = fit(groups, vectors, with_base=True)
    taste_weights = w[1:]
    photo_ids = {p.photo_id for g in groups for p in g.photos}
    offset = float(np.mean([vectors[pid] @ taste_weights for pid in photo_ids]))
    return TasteModel(
        base_weight=float(w[0]),
        weights=taste_weights,
        offset=offset,
        ridge_lambda=lam,
        groups=len(groups),
        pairs=pairs,
        train_pair_accuracy=accuracy,
    )

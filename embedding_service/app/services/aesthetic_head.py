"""Provisional aesthetic score from the CLIP vector (foto-aesthetik, stage 4).

The nightly job scores photos with Q-Align on the GPU. A photo imported
during the day has only the CLIP ViT-H/14 vector this service computes
anyway, so a linear head on that vector predicts what Q-Align would say.
It is trained on the household's own Q-Align scores (the app sends
photo id and score, the vectors are already here), not on AVA: it imitates
the scorer that overwrites it at night, on the kind of photos it will see.

The head is ridge regression, closed form in NumPy. The strength is chosen
on a validation split; the test split decides whether the head is used at
all: only when its rank correlation with Q-Align beats the zero-shot CLIP
prompts on the same photos. A worse head is kept on disk for the report
but `/quality` ignores it.
"""

from __future__ import annotations

import json
import logging
import os
import threading
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, Sequence

import numpy as np

logger = logging.getLogger(__name__)

#: Written to `photos.aesthetic_model` in the app for a provisional score.
HEAD_VERSION = "vith_head_v1"

#: Below this many Q-Align scores a head is not trained.
MIN_SAMPLES = 500

#: Candidate ridge strengths, chosen on the validation split.
RIDGE_LAMBDAS = (0.1, 1.0, 10.0, 100.0, 1000.0)

#: The zero-shot prompts `/quality` used for `clip_aesthetics` before; the
#: training compares the head against them on the same test photos.
AESTHETIC_POSITIVE = [
    "a beautiful aesthetically pleasing photograph",
    "a stunning artistic photo with emotional impact",
]
AESTHETIC_NEGATIVE = [
    "an ugly snapshot with no artistic merit",
    "a boring uninteresting photograph",
]


def head_path() -> Path:
    """Where the head lives: the models volume, so it survives a new image."""
    models_dir = Path(os.environ.get("MODELS_DIR", "/models"))
    return models_dir / "aesthetic_head" / f"{HEAD_VERSION}.npz"


@dataclass
class HeadReport:
    version: str
    active: bool
    trained_at: str
    samples: int
    train: int
    validation: int
    test: int
    ridge_lambda: float
    #: Spearman rank correlation with Q-Align on the test photos.
    spearman_head: float
    spearman_zero_shot: float
    #: Mean absolute error on the 0–1 scale, test photos.
    mae_head: float


@dataclass
class Head:
    weights: np.ndarray
    bias: float
    report: HeadReport

    def predict(self, vectors: np.ndarray) -> np.ndarray:
        """0–1 scores for one vector or a stack of them."""
        raw = np.atleast_2d(vectors).astype(np.float64) @ self.weights + self.bias
        return np.clip(raw, 0.0, 1.0)


class TooFewSamplesError(ValueError):
    pass


def spearman(a: Sequence[float], b: Sequence[float]) -> float:
    """Spearman's rho with average ranks for ties; 0 when one side is constant."""
    ra = _ranks(np.asarray(a, dtype=np.float64))
    rb = _ranks(np.asarray(b, dtype=np.float64))
    if ra.std() == 0 or rb.std() == 0:
        return 0.0
    return float(np.corrcoef(ra, rb)[0, 1])


def _ranks(x: np.ndarray) -> np.ndarray:
    order = np.argsort(x, kind="mergesort")
    ranks = np.empty(len(x), dtype=np.float64)
    ranks[order] = np.arange(len(x), dtype=np.float64)
    # Average the ranks of equal values, so ties do not depend on order.
    _, inverse, counts = np.unique(x, return_inverse=True, return_counts=True)
    sums = np.bincount(inverse, weights=ranks)
    return (sums / counts)[inverse]


def zero_shot_scores(vectors: np.ndarray, positive: np.ndarray, negative: np.ndarray) -> np.ndarray:
    """The old `clip_aesthetics` for a stack of image vectors (same mapping as `/quality`)."""
    diff = vectors @ positive.mean(axis=0) - vectors @ negative.mean(axis=0)
    return np.clip((diff + 0.15) / 0.30, 0.0, 1.0)


def _ridge(x: np.ndarray, y: np.ndarray, lam: float) -> tuple[np.ndarray, float]:
    """Ridge on centred data, so the bias is not shrunk."""
    x_mean = x.mean(axis=0)
    y_mean = float(y.mean())
    xc = x - x_mean
    a = xc.T @ xc + lam * np.eye(x.shape[1])
    w = np.linalg.solve(a, xc.T @ (y - y_mean))
    return w, y_mean - float(x_mean @ w)


def train(
    vectors: np.ndarray,
    targets: np.ndarray,
    zero_shot: np.ndarray,
    seed: int = 0,
    now: Optional[datetime] = None,
) -> Head:
    """Fits the head on 70 % of the photos, picks the strength on 15 %, reports on 15 %."""
    n = len(targets)
    if n < MIN_SAMPLES:
        raise TooFewSamplesError(f"{n} Q-Align-Werte, gebraucht werden mindestens {MIN_SAMPLES}")
    x = np.asarray(vectors, dtype=np.float64)
    y = np.asarray(targets, dtype=np.float64)
    order = np.random.default_rng(seed).permutation(n)
    n_test = max(1, int(n * 0.15))
    n_val = max(1, int(n * 0.15))
    test, val, fit = order[:n_test], order[n_test:n_test + n_val], order[n_test + n_val:]

    best: Optional[tuple[float, float]] = None
    for lam in RIDGE_LAMBDAS:
        w, b = _ridge(x[fit], y[fit], lam)
        rho = spearman(x[val] @ w + b, y[val])
        if best is None or rho > best[0]:
            best = (rho, lam)
    lam = best[1]

    # The final head sees training and validation photos; the test photos
    # stay unseen so the report says how it does on new ones.
    seen = np.concatenate([fit, val])
    w, b = _ridge(x[seen], y[seen], lam)
    pred = np.clip(x[test] @ w + b, 0.0, 1.0)
    rho_head = spearman(pred, y[test])
    rho_zero = spearman(np.asarray(zero_shot, dtype=np.float64)[test], y[test])
    report = HeadReport(
        version=HEAD_VERSION,
        active=rho_head > rho_zero,
        trained_at=(now or datetime.now(timezone.utc)).isoformat(timespec="seconds"),
        samples=n,
        train=len(fit),
        validation=len(val),
        test=len(test),
        ridge_lambda=lam,
        spearman_head=round(rho_head, 4),
        spearman_zero_shot=round(rho_zero, 4),
        mae_head=round(float(np.abs(pred - y[test]).mean()), 4),
    )
    return Head(weights=w, bias=b, report=report)


# ─── Persistence ─────────────────────────────────────────────────────────────

_lock = threading.Lock()
_cached: Optional[Head] = None
_cached_mtime: Optional[float] = None


def save(head: Head, path: Optional[Path] = None) -> None:
    target = path or head_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(".tmp.npz")
    np.savez(tmp, weights=head.weights, bias=np.array([head.bias]), report=json.dumps(asdict(head.report)))
    os.replace(tmp, target)
    global _cached, _cached_mtime
    with _lock:
        _cached, _cached_mtime = head, target.stat().st_mtime


def load(path: Optional[Path] = None) -> Optional[Head]:
    """The head on disk, cached until the file changes; None when there is none."""
    global _cached, _cached_mtime
    source = path or head_path()
    try:
        mtime = source.stat().st_mtime
    except FileNotFoundError:
        return None
    with _lock:
        if _cached is not None and _cached_mtime == mtime:
            return _cached
        try:
            with np.load(source, allow_pickle=False) as data:
                report = HeadReport(**json.loads(str(data["report"])))
                head = Head(weights=data["weights"], bias=float(data["bias"][0]), report=report)
        except Exception:
            logger.exception("Aesthetic head at %s is unreadable; ignoring it", source)
            return None
        _cached, _cached_mtime = head, mtime
        return head


def active_head(path: Optional[Path] = None) -> Optional[Head]:
    """The head `/quality` uses: present and better than zero-shot on its test photos."""
    head = load(path)
    return head if head is not None and head.report.active else None

"""Off-line A/B evaluation for embedding-model swaps.

Compares a `reference` embedder against a `candidate` embedder on three
levels — vector cosine, burst-grouping stability, and CLIP text recall@K.
Run with both backends set to "torch" for a sanity check (should produce
near-perfect scores, since the only variation comes from non-determinism in
PyTorch CPU kernels). Once an alternative backend (e.g. ONNX/INT8) lands,
flip --candidate to it and re-run.

Why offline / not a unit test:
- Needs real images on disk, which Docker tests don't have.
- Runs on the order of minutes, not milliseconds, on the production model.
- Output is a human-read report, not a pass/fail signal you'd gate CI on.

Typical use, from inside the embedding_service container:
    docker compose exec embedding_service \\
        python -m app.scripts.quantization_eval --sample 500
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys
from dataclasses import dataclass
from itertools import combinations
from typing import Callable, Dict, List, Optional, Sequence, Tuple

import numpy as np
from PIL import Image, ImageFile
from sqlalchemy import text

# Tolerate a few corrupted bytes at the end of JPEGs — same policy the
# service uses (see app/api/endpoints.py).
ImageFile.LOAD_TRUNCATED_IMAGES = True

from app.config import settings
from app.db.database import engine
from app.services.similar_groups import find_similar_groups

logger = logging.getLogger("quantization_eval")


# ---------------------------------------------------------------------------
# Backends
# ---------------------------------------------------------------------------


class TorchBackend:
    """PyTorch reference path — wraps the production CLIPEmbedder/DINOv2Embedder."""

    name = "torch"

    def __init__(self) -> None:
        # Lazy import so a missing-torch failure surfaces only when this
        # backend is actually requested.
        from app.services.embedding_service import CLIPEmbedder, DINOv2Embedder

        self._clip = CLIPEmbedder.get_instance(
            model_name=settings.clip_model_name, pretrained=settings.clip_pretrained
        )
        self._dino = DINOv2Embedder.get_instance(model_name=settings.dino_model_name)

    def embed_image_clip(self, images: List[Image.Image]) -> np.ndarray:
        return np.asarray(self._clip.embed(images), dtype=np.float32)

    def embed_image_dino(self, images: List[Image.Image]) -> np.ndarray:
        return np.asarray(self._dino.embed(images), dtype=np.float32)

    def embed_text_clip(self, query: str) -> np.ndarray:
        return np.asarray(self._clip.embed_text(query), dtype=np.float32)


class OnnxInt8BackendAdapter:
    """Lazy wrapper so missing onnxruntime / missing artefacts don't crash
    the script at import time — the ONNX path is only loaded when a caller
    actually selects --reference=onnx-int8 or --candidate=onnx-int8.
    """

    name = "onnx-int8"

    def __init__(self) -> None:
        from app.services.onnx_backend import OnnxInt8Backend

        self._inner = OnnxInt8Backend()

    def embed_image_clip(self, images: List[Image.Image]) -> np.ndarray:
        return self._inner.embed_image_clip(images)

    def embed_image_dino(self, images: List[Image.Image]) -> np.ndarray:
        return self._inner.embed_image_dino(images)

    def embed_text_clip(self, query: str) -> np.ndarray:
        return self._inner.embed_text_clip(query)


BACKENDS: Dict[str, Callable[[], object]] = {
    "torch": TorchBackend,
    "onnx-int8": OnnxInt8BackendAdapter,
}


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------


@dataclass
class Sample:
    photo_id: str
    file_path: str
    timestamp: float  # epoch seconds; missing timestamps are dropped earlier


def _parse_vec(value, dim: int) -> np.ndarray:
    """Coerce a pgvector column value into an (D,) float32 array.

    pgvector returns either a numpy ndarray / list (when the asyncpg codec
    is registered, as the SQLAlchemy ORM does for mapped Vector columns) or
    the raw text representation "[0.1,0.2,...]" (which is what raw text()
    queries get back over the same engine, since the codec sits on the
    connection rather than the cursor). Handle both — the second form is
    why this script's first --source=db run blew up with "inhomogeneous
    shape" instead of producing a clean (N, D) matrix.
    """
    if value is None:
        return np.zeros(dim, dtype=np.float32)
    if isinstance(value, str):
        # Strip "[" / "]" then split by comma. np.fromstring handles whitespace.
        return np.fromstring(value.strip().lstrip("[").rstrip("]"), sep=",", dtype=np.float32)
    return np.asarray(value, dtype=np.float32)


def _stack_vecs(values: List, dim: int) -> np.ndarray:
    if not values:
        return np.zeros((0, dim), dtype=np.float32)
    return np.vstack([_parse_vec(v, dim) for v in values])


async def sample_photos(n: int, with_embeddings: bool) -> Tuple[List[Sample], Optional[np.ndarray], Optional[np.ndarray]]:
    """Random sample of photos that already have both embeddings + a timestamp.

    When `with_embeddings` is True, the stored CLIP/DINOv2 vectors come back
    in the same call so the caller can skip the (often impossible inside the
    embedding container) image-loading step entirely. Filtering by
    `embedding_clip IS NOT NULL` keeps corrupted / unreadable files out of
    the sample regardless of mode.
    """
    if with_embeddings:
        query = text(
            """
            SELECT photo_id, file_path, EXTRACT(EPOCH FROM timestamp) AS ts,
                   embedding_clip, embedding_dino
            FROM photos
            WHERE embedding_clip IS NOT NULL
              AND embedding_dino IS NOT NULL
              AND timestamp IS NOT NULL
            ORDER BY random()
            LIMIT :limit
            """
        )
    else:
        query = text(
            """
            SELECT photo_id, file_path, EXTRACT(EPOCH FROM timestamp) AS ts
            FROM photos
            WHERE embedding_clip IS NOT NULL
              AND embedding_dino IS NOT NULL
              AND timestamp IS NOT NULL
            ORDER BY random()
            LIMIT :limit
            """
        )

    async with engine.connect() as conn:
        result = await conn.execute(query, {"limit": n})
        rows = result.fetchall()

    samples = [Sample(photo_id=r[0], file_path=r[1], timestamp=float(r[2])) for r in rows]
    # similar_groups requires timestamp-sorted input; sort sample list and
    # the embedding matrices in lockstep so row i still describes sample i.
    if with_embeddings:
        order = sorted(range(len(rows)), key=lambda i: float(rows[i][2]))
        samples = [samples[i] for i in order]
        clip = _stack_vecs([rows[i][3] for i in order], 1024)
        dino = _stack_vecs([rows[i][4] for i in order], 768)
        return samples, clip, dino

    samples.sort(key=lambda s: s.timestamp)
    return samples, None, None


_skipped_examples: List[str] = []
_skipped_count = 0


def _open_image(path: str) -> Optional[Image.Image]:
    global _skipped_count
    try:
        return Image.open(path).convert("RGB")
    except Exception as exc:
        # Per-file warnings drown the console at 500 sample size; collect a
        # handful of representative paths and report a single summary later.
        _skipped_count += 1
        if len(_skipped_examples) < 3:
            _skipped_examples.append(f"{path}: {exc}")
        return None


def embed_all(
    backend: object,
    samples: Sequence[Sample],
    batch_size: int,
) -> Tuple[List[Sample], np.ndarray, np.ndarray]:
    """Run both encoders over `samples`, returning kept samples + matrices.

    Photos whose file failed to open are dropped from `kept`; the caller
    must use the returned list (not the input) for downstream alignment.
    """
    kept: List[Sample] = []
    clip_chunks: List[np.ndarray] = []
    dino_chunks: List[np.ndarray] = []

    total = len(samples)
    for start in range(0, total, batch_size):
        chunk = samples[start : start + batch_size]
        images: List[Image.Image] = []
        chunk_kept: List[Sample] = []
        for s in chunk:
            img = _open_image(s.file_path)
            if img is not None:
                images.append(img)
                chunk_kept.append(s)
        if not images:
            continue
        clip_chunks.append(backend.embed_image_clip(images))  # type: ignore[attr-defined]
        dino_chunks.append(backend.embed_image_dino(images))  # type: ignore[attr-defined]
        kept.extend(chunk_kept)
        done = start + len(chunk)
        print(f"  {done}/{total} embedded", end="\r", flush=True)
    print()

    clip = np.vstack(clip_chunks) if clip_chunks else np.zeros((0, 1024), dtype=np.float32)
    dino = np.vstack(dino_chunks) if dino_chunks else np.zeros((0, 768), dtype=np.float32)
    return kept, clip, dino


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------


def cosine_stats(ref: np.ndarray, cand: np.ndarray) -> Dict[str, float]:
    """Per-row cosine between reference and candidate, assumed unit-normalized.

    Embedders in this codebase normalise outputs already; we re-normalise
    here defensively so the script also gives sensible numbers if a future
    backend forgets to.
    """
    ref = ref / np.maximum(np.linalg.norm(ref, axis=1, keepdims=True), 1e-12)
    cand = cand / np.maximum(np.linalg.norm(cand, axis=1, keepdims=True), 1e-12)
    sims = (ref * cand).sum(axis=1)
    return {
        "mean": float(sims.mean()),
        "p5": float(np.percentile(sims, 5)),
        "p1": float(np.percentile(sims, 1)),
        "min": float(sims.min()),
    }


def groups_to_pairs(groups: List[Tuple[str, List[str]]]) -> set:
    """Convert {(cover, [members])} into the set of unordered (a,b) pairs.

    Pair representation makes recall/precision a straightforward set
    operation, side-stepping the harder "did the same partition emerge"
    question (the cover IDs and member orderings can shift even when the
    underlying clustering is identical).
    """
    pairs = set()
    for _cover, members in groups:
        for a, b in combinations(sorted(members), 2):
            pairs.add((a, b))
    return pairs


def pair_metrics(ref_pairs: set, cand_pairs: set) -> Dict[str, float]:
    tp = len(ref_pairs & cand_pairs)
    recall = tp / len(ref_pairs) if ref_pairs else 1.0
    precision = tp / len(cand_pairs) if cand_pairs else 1.0
    f1 = 2 * recall * precision / (recall + precision) if (recall + precision) else 0.0
    return {
        "recall": recall,
        "precision": precision,
        "f1": f1,
        "ref_pairs": float(len(ref_pairs)),
        "cand_pairs": float(len(cand_pairs)),
        "tp": float(tp),
    }


def topk_search(
    query_vec: np.ndarray, haystack: np.ndarray, k: int
) -> List[int]:
    """Return indices of the top-k cosine matches in `haystack`.

    Both inputs assumed unit-normalized. Uses argpartition (O(N)) instead of
    full argsort because we only need the top-k order, and at N=500 the
    constant factor on argsort isn't free.
    """
    sims = haystack @ query_vec
    if k >= len(sims):
        return list(np.argsort(-sims))
    part = np.argpartition(-sims, k)[:k]
    return list(part[np.argsort(-sims[part])])


def recall_at_k(ref_topk: List[List[int]], cand_topk: List[List[int]], k: int) -> Dict[str, float]:
    recalls = [
        len(set(r[:k]) & set(c[:k])) / k
        for r, c in zip(ref_topk, cand_topk)
    ]
    if not recalls:
        return {"mean": 1.0, "min": 1.0, "p5": 1.0}
    return {
        "mean": float(np.mean(recalls)),
        "min": float(min(recalls)),
        "p5": float(np.percentile(recalls, 5)),
    }


# ---------------------------------------------------------------------------
# Evaluation passes
# ---------------------------------------------------------------------------


def eval_groups(
    samples: Sequence[Sample],
    dino_ref: np.ndarray,
    dino_cand: np.ndarray,
    threshold: float,
    window_seconds: float,
) -> Tuple[Dict[str, float], int, int]:
    rows_ref = [
        (s.photo_id, s.timestamp, dino_ref[i].tolist())
        for i, s in enumerate(samples)
    ]
    rows_cand = [
        (s.photo_id, s.timestamp, dino_cand[i].tolist())
        for i, s in enumerate(samples)
    ]
    g_ref = find_similar_groups(rows_ref, threshold=threshold, time_window_seconds=window_seconds)
    g_cand = find_similar_groups(rows_cand, threshold=threshold, time_window_seconds=window_seconds)
    return pair_metrics(groups_to_pairs(g_ref), groups_to_pairs(g_cand)), len(g_ref), len(g_cand)


def eval_text_recall(
    backend_ref: object,
    backend_cand: object,
    queries: List[str],
    clip_ref: np.ndarray,
    clip_cand: np.ndarray,
    k: int,
) -> Tuple[Dict[str, float], List[Tuple[str, float]]]:
    ref_topk: List[List[int]] = []
    cand_topk: List[List[int]] = []
    per_query: List[Tuple[str, float]] = []

    # Re-normalise haystack defensively (cheap, paid once).
    ref_haystack = clip_ref / np.maximum(np.linalg.norm(clip_ref, axis=1, keepdims=True), 1e-12)
    cand_haystack = clip_cand / np.maximum(np.linalg.norm(clip_cand, axis=1, keepdims=True), 1e-12)

    for q in queries:
        qr = backend_ref.embed_text_clip(q)  # type: ignore[attr-defined]
        qc = backend_cand.embed_text_clip(q)  # type: ignore[attr-defined]
        qr = qr / max(np.linalg.norm(qr), 1e-12)
        qc = qc / max(np.linalg.norm(qc), 1e-12)

        r = topk_search(qr, ref_haystack, k)
        c = topk_search(qc, cand_haystack, k)
        ref_topk.append(r)
        cand_topk.append(c)
        overlap = len(set(r) & set(c)) / k
        per_query.append((q, overlap))

    return recall_at_k(ref_topk, cand_topk, k), per_query


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--sample", type=int, default=500, help="Number of photos to sample (default: 500)")
    p.add_argument("--reference", choices=sorted(BACKENDS.keys()), default="torch")
    p.add_argument("--candidate", choices=sorted(BACKENDS.keys()), default="torch")
    p.add_argument(
        "--source",
        choices=["db", "disk"],
        default="db",
        help=(
            "Where image embeddings come from. 'db' (default) reads the "
            "stored fp32 vectors from the embedding service's own DB, which "
            "needs no filesystem access — suitable for sanity-checking the "
            "pipeline and for any candidate backend that can also be evaluated "
            "from pre-stored vectors. 'disk' re-embeds each photo from its "
            "on-disk path; required for backends like ONNX-INT8 where the "
            "whole point is to compute fresh vectors. Note that the embedding "
            "service container does not normally see /mnt/libraries — disk "
            "mode therefore needs that volume mounted in too."
        ),
    )
    p.add_argument("--threshold", type=float, default=0.90, help="Cosine threshold for grouping (matches production)")
    p.add_argument("--window-seconds", type=float, default=600.0, help="Time window for grouping (matches production)")
    p.add_argument("--batch-size", type=int, default=8)
    p.add_argument(
        "--queries-file",
        default=None,
        help="Path to a text file with one query per line. Defaults to app/scripts/eval_queries.txt; "
             "pass empty string to skip the text-recall eval.",
    )
    p.add_argument("--top-k", type=int, default=10)
    p.add_argument("--gate-cosine", type=float, default=0.995, help="Pass threshold for mean per-photo cosine")
    p.add_argument("--gate-pair-recall", type=float, default=0.97)
    p.add_argument("--gate-pair-precision", type=float, default=0.97)
    p.add_argument("--gate-text-recall", type=float, default=0.95)
    return p.parse_args()


def _load_queries(path_arg: Optional[str]) -> List[str]:
    if path_arg == "":
        return []
    if path_arg is None:
        path = "app/scripts/eval_queries.txt"
    else:
        path = path_arg
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return [line.strip() for line in fh if line.strip() and not line.lstrip().startswith("#")]
    except FileNotFoundError:
        logger.warning("queries file %s not found — skipping text-recall eval", path)
        return []


def _fmt(d: Dict[str, float]) -> str:
    return ", ".join(f"{k}={v:.4f}" for k, v in d.items())


async def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(levelname)-7s | %(message)s")
    args = parse_args()

    use_db_source = args.source == "db"

    print(f"Sampling {args.sample} photos from DB (source={args.source})...")
    samples, clip_db, dino_db = await sample_photos(args.sample, with_embeddings=use_db_source)
    if not samples:
        print("No photos with embeddings found. Run the service against your library first.", file=sys.stderr)
        return 2
    print(f"  got {len(samples)} samples (sorted by timestamp)")

    # In db mode the candidate vectors are identical to the reference (both
    # come from the stored fp32 embeddings), so neither backend has to be
    # loaded for image embedding. The text encoder is still required for
    # Level 3, so we lazy-load it then.
    ref_backend: Optional[object] = None
    cand_backend: Optional[object] = None

    if use_db_source:
        if args.reference != args.candidate:
            print(
                "ERROR: --source=db cannot compare two different backends — both sides "
                "would just read the same stored vectors. Use --source=disk for a real "
                "backend swap.",
                file=sys.stderr,
            )
            return 2
        clip_ref = clip_db
        dino_ref = dino_db
        clip_cand = clip_ref.copy()
        dino_cand = dino_ref.copy()
        samples_aligned = samples
        print(f"\nUsing pre-stored fp32 vectors from DB ({len(samples)} photos, no model load needed for image pass)")
    else:
        print(f"\nLoading reference backend '{args.reference}'...")
        ref_backend = BACKENDS[args.reference]()
        print(f"Loading candidate backend '{args.candidate}'...")
        cand_backend = BACKENDS[args.candidate]() if args.candidate != args.reference else ref_backend

        print(f"\nEmbedding with reference '{args.reference}':")
        samples_ref, clip_ref, dino_ref = embed_all(ref_backend, samples, args.batch_size)

        if cand_backend is ref_backend:
            # No need to redo the work for a self-comparison; downstream metrics
            # then exercise determinism / numeric noise rather than model drift.
            clip_cand = clip_ref.copy()
            dino_cand = dino_ref.copy()
            samples_cand = samples_ref
        else:
            print(f"\nEmbedding with candidate '{args.candidate}':")
            samples_cand, clip_cand, dino_cand = embed_all(cand_backend, samples, args.batch_size)

        if _skipped_count > 0:
            print(f"\n  skipped {_skipped_count} photo(s) whose file was not readable.")
            for ex in _skipped_examples:
                print(f"    e.g. {ex}")
            print(
                "  hint: the embedding service container does not normally see "
                "/mnt/libraries. Either mount it read-only into this container, or "
                "use --source=db (which reads stored fp32 vectors from the DB and "
                "skips disk access entirely)."
            )

        if not samples_ref:
            print(
                "\nERROR: no photos could be loaded from disk. Re-run with --source=db, "
                "or mount the photo libraries into this container. Aborting.",
                file=sys.stderr,
            )
            return 2

        # Align: only photos that survived BOTH passes count (different backends
        # may fail on different files in the rare corruption case).
        ref_ids = {s.photo_id for s in samples_ref}
        cand_ids = {s.photo_id for s in samples_cand}
        keep_ids = ref_ids & cand_ids
        if len(keep_ids) < len(samples_ref) or len(keep_ids) < len(samples_cand):
            print(f"\n  aligning to {len(keep_ids)} photos that both backends embedded successfully")
            ref_idx = [i for i, s in enumerate(samples_ref) if s.photo_id in keep_ids]
            cand_idx = [i for i, s in enumerate(samples_cand) if s.photo_id in keep_ids]
            samples_aligned = [samples_ref[i] for i in ref_idx]
            clip_ref = clip_ref[ref_idx]
            dino_ref = dino_ref[ref_idx]
            # Re-order candidate matrices to the same photo_id sequence as ref.
            cand_pos = {samples_cand[i].photo_id: i for i in cand_idx}
            order = [cand_pos[s.photo_id] for s in samples_aligned]
            clip_cand = clip_cand[order]
            dino_cand = dino_cand[order]
        else:
            samples_aligned = samples_ref

    # ---- Level 1 — per-photo cosine ----
    print("\nLevel 1 — Embedding cosine (ref vs candidate, per photo):")
    clip_stats = cosine_stats(clip_ref, clip_cand)
    dino_stats = cosine_stats(dino_ref, dino_cand)
    print(f"  CLIP   {_fmt(clip_stats)}")
    print(f"  DINOv2 {_fmt(dino_stats)}")

    # ---- Level 2 — group stability ----
    print(f"\nLevel 2 — Group stability "
          f"(DINOv2, threshold={args.threshold}, window={args.window_seconds:.0f}s):")
    pair, n_ref_groups, n_cand_groups = eval_groups(
        samples_aligned, dino_ref, dino_cand, args.threshold, args.window_seconds
    )
    print(f"  reference groups: {n_ref_groups} ({int(pair['ref_pairs'])} pairs)")
    print(f"  candidate groups: {n_cand_groups} ({int(pair['cand_pairs'])} pairs)")
    print(f"  pair-recall:    {pair['recall']:.4f} "
          f"({int(pair['tp'])}/{int(pair['ref_pairs'])} ref pairs preserved)")
    print(f"  pair-precision: {pair['precision']:.4f} "
          f"({int(pair['tp'])}/{int(pair['cand_pairs'])} cand pairs are real)")
    print(f"  pair-F1:        {pair['f1']:.4f}")

    # ---- Level 3 — CLIP text recall@K ----
    queries = _load_queries(args.queries_file)
    text_stats: Optional[Dict[str, float]] = None
    if queries:
        # In db mode neither backend was instantiated above; we still need a
        # working text encoder for the recall test. Lazy-load it here.
        if ref_backend is None:
            print(f"\nLoading reference backend '{args.reference}' for text encoding...")
            ref_backend = BACKENDS[args.reference]()
        if cand_backend is None:
            cand_backend = ref_backend if args.reference == args.candidate else BACKENDS[args.candidate]()

        print(f"\nLevel 3 — CLIP text recall@{args.top_k} ({len(queries)} queries):")
        text_stats, per_query = eval_text_recall(
            ref_backend, cand_backend, queries, clip_ref, clip_cand, args.top_k
        )
        print(f"  mean:  {text_stats['mean']:.4f}")
        print(f"  p5:    {text_stats['p5']:.4f}")
        print(f"  min:   {text_stats['min']:.4f}")
        worst = sorted(per_query, key=lambda x: x[1])[:3]
        for q, r in worst:
            print(f"    worst: {r:.2f}  '{q}'")
    else:
        print("\nLevel 3 — CLIP text recall@K: skipped (no queries file)")

    # ---- Verdict ----
    gates = {
        "CLIP cos mean":     (clip_stats["mean"],  args.gate_cosine),
        "DINOv2 cos mean":   (dino_stats["mean"],  args.gate_cosine),
        "pair-recall":       (pair["recall"],      args.gate_pair_recall),
        "pair-precision":    (pair["precision"],   args.gate_pair_precision),
    }
    if text_stats is not None:
        gates["text recall@K"] = (text_stats["mean"], args.gate_text_recall)

    print("\nVerdict:")
    failed = []
    for name, (value, threshold) in gates.items():
        ok = value >= threshold
        marker = "PASS" if ok else "FAIL"
        print(f"  [{marker}] {name}: {value:.4f}  (gate ≥ {threshold:.4f})")
        if not ok:
            failed.append(name)
    if failed:
        print(f"\nResult: FAIL — {len(failed)} gate(s) failed.")
        return 1
    print("\nResult: PASS — all gates green.")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))

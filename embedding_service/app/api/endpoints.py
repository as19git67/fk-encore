"""FastAPI route handlers."""

from __future__ import annotations

import io
import logging
from datetime import datetime
from typing import Annotated, List, Optional

from fastapi import APIRouter, Depends, HTTPException, status, File, UploadFile, Form
from PIL import UnidentifiedImageError
from PIL import Image
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db.database import check_db_connection, get_db
from app.db import repository
from app.models.schemas import (
    EmbedRequest,
    EmbedResponse,
    GetRequest,
    GetResponse,
    HealthResponse,
    PhotoRecord,
    SearchRequest,
    SearchResponse,
    SearchResult,
    TextSearchRequest,
)
from app.services.embedding_service import CLIPEmbedder, DINOv2Embedder

logger = logging.getLogger(__name__)
router = APIRouter()

DbDep = Annotated[AsyncSession, Depends(get_db)]


# ---------------------------------------------------------------------------
# /health
# ---------------------------------------------------------------------------

@router.get("/health", response_model=HealthResponse, tags=["ops"])
async def health(db: DbDep) -> HealthResponse:
    db_ok = await check_db_connection()
    clip_loaded = CLIPEmbedder._instance is not None
    dino_loaded = DINOv2Embedder._instance is not None
    
    # If lazy loading is disabled (default), we consider the service "ok" only if models are loaded.
    # Otherwise, "ok" (or "degraded") reflects the DB status.
    is_ok = db_ok
    if not settings.lazy_load_models and (not clip_loaded or not dino_loaded):
        is_ok = False
        
    return HealthResponse(
        status="ok" if is_ok else ("degraded" if db_ok else "error"),
        db="ok" if db_ok else "error",
        models={"clip": "loaded" if clip_loaded else "not_loaded", "dino": "loaded" if dino_loaded else "not_loaded"},
    )


# ---------------------------------------------------------------------------
# /embed
# ---------------------------------------------------------------------------

@router.post("/embed", response_model=EmbedResponse, status_code=status.HTTP_200_OK, tags=["embeddings"])
async def embed(request: EmbedRequest, db: DbDep) -> EmbedResponse:
    """Generate CLIP + DINOv2 embeddings for a batch of photos and persist them."""
    photo_ids = [p.photo_id for p in request.photos]

    # Skip photos already in DB
    existing = await repository.get_existing_photo_ids(db, photo_ids)
    new_photos = [p for p in request.photos if p.photo_id not in existing]

    if not new_photos:
        logger.info("All %d photos already exist – nothing to process.", len(photo_ids))
        return EmbedResponse(status="ok", processed=0)

    file_paths = [p.file_path for p in new_photos]

    try:
        clip_embedder = CLIPEmbedder.get_instance(
            model_name=settings.clip_model_name, pretrained=settings.clip_pretrained
        )
        dino_embedder = DINOv2Embedder.get_instance(model_name=settings.dino_model_name)

        images = [Image.open(p).convert("RGB") for p in file_paths]
        clip_embeddings = clip_embedder.embed(images)
        dino_embeddings = dino_embedder.embed(images)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Embedding generation failed")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Embedding error") from exc

    rows = []
    for photo, clip_vec, dino_vec in zip(new_photos, clip_embeddings, dino_embeddings):
        ts = photo.timestamp
        if ts and ts.tzinfo is not None:
            ts = ts.replace(tzinfo=None)
        rows.append(
            {
                "photo_id": photo.photo_id,
                "file_path": photo.file_path,
                "timestamp": ts,
                "camera_id": photo.camera_id,
                "face_ids": photo.face_ids or [],
                "embedding_clip": clip_vec,
                "embedding_dino": dino_vec,
            }
        )

    inserted = await repository.upsert_photos(db, rows)
    logger.info("Inserted %d / %d photos.", inserted, len(new_photos))
    return EmbedResponse(status="ok", processed=inserted)


# ---------------------------------------------------------------------------
# /upload
# ---------------------------------------------------------------------------

@router.post("/upload", response_model=EmbedResponse, tags=["embeddings"])
async def upload_photo(
    db: DbDep,
    photo_id: str = Form(...),
    file_path: str = Form(...),
    timestamp: Optional[datetime] = Form(None),
    camera_id: Optional[str] = Form(None),
    face_ids: Optional[str] = Form(None),  # Comma-separated list
    force: bool = Form(False),
    file: UploadFile = File(...),
) -> EmbedResponse:
    """Generate CLIP + DINOv2 embeddings for an uploaded photo and persist them."""
    # Skip if photo already in DB (unless force re-embed is requested)
    if not force:
        existing = await repository.get_existing_photo_ids(db, [photo_id])
        if photo_id in existing:
            logger.info("Photo %s already exists – skipping.", photo_id)
            return EmbedResponse(status="ok", processed=0)

    try:
        content = await file.read()
        image = Image.open(io.BytesIO(content)).convert("RGB")

        clip_embedder = CLIPEmbedder.get_instance(
            model_name=settings.clip_model_name, pretrained=settings.clip_pretrained
        )
        dino_embedder = DINOv2Embedder.get_instance(model_name=settings.dino_model_name)

        clip_embeddings = clip_embedder.embed([image])
        dino_embeddings = dino_embedder.embed([image])
    except UnidentifiedImageError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Unsupported or corrupted image format") from exc
    except Exception as exc:
        logger.exception("Embedding generation failed")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Embedding error") from exc

    faces = face_ids.split(",") if face_ids else []

    if timestamp and timestamp.tzinfo is not None:
        timestamp = timestamp.replace(tzinfo=None)

    row = {
        "photo_id": photo_id,
        "file_path": file_path,
        "timestamp": timestamp,
        "camera_id": camera_id,
        "face_ids": faces,
        "embedding_clip": clip_embeddings[0],
        "embedding_dino": dino_embeddings[0],
    }

    inserted = await repository.upsert_photos(db, [row], overwrite=force)
    logger.info("Uploaded photo %s processed and stored.", photo_id)
    return EmbedResponse(status="ok", processed=inserted)


# ---------------------------------------------------------------------------
# /search
# ---------------------------------------------------------------------------

@router.post("/search", response_model=SearchResponse, tags=["search"])
async def search(request: SearchRequest, db: DbDep) -> SearchResponse:
    """Perform vector similarity search using CLIP, DINOv2, or a hybrid of both."""
    photos = await repository.get_photos_by_ids(db, [request.photo_id])
    if not photos:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="photo_id not found")

    photo = photos[0]

    if request.mode == "clip":
        if photo.embedding_clip is None:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="No CLIP embedding for this photo")
        rows = await repository.search_by_clip(db, list(photo.embedding_clip), request.k)
        results = [SearchResult(photo_id=pid, score=score) for pid, score in rows]

    elif request.mode == "dino":
        if photo.embedding_dino is None:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="No DINOv2 embedding for this photo")
        rows = await repository.search_by_dino(db, list(photo.embedding_dino), request.k)
        results = [SearchResult(photo_id=pid, score=score) for pid, score in rows]

    else:  # hybrid
        if photo.embedding_clip is None or photo.embedding_dino is None:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Both CLIP and DINOv2 embeddings required for hybrid search",
            )
        clip_rows = await repository.search_by_clip(db, list(photo.embedding_clip), request.k * 2)
        dino_rows = await repository.search_by_dino(db, list(photo.embedding_dino), request.k * 2)

        scores: dict[str, float] = {}
        for pid, score in clip_rows:
            scores[pid] = scores.get(pid, 0.0) + 0.5 * score
        for pid, score in dino_rows:
            scores[pid] = scores.get(pid, 0.0) + 0.5 * score

        sorted_results = sorted(scores.items(), key=lambda x: x[1], reverse=True)[: request.k]
        results = [SearchResult(photo_id=pid, score=score) for pid, score in sorted_results]

    return SearchResponse(results=results)


# ---------------------------------------------------------------------------
# /search/text
# ---------------------------------------------------------------------------

@router.post("/search/text", response_model=SearchResponse, tags=["search"])
async def search_by_text(request: TextSearchRequest, db: DbDep) -> SearchResponse:
    """Perform semantic image search using a natural language query via CLIP text embeddings."""
    try:
        clip_embedder = CLIPEmbedder.get_instance(
            model_name=settings.clip_model_name, pretrained=settings.clip_pretrained
        )
        query_vector = clip_embedder.embed_text(request.query)
    except Exception as exc:
        logger.exception("Text embedding generation failed")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Text embedding error") from exc

    rows = await repository.search_by_clip(db, query_vector, request.k)
    results = [
        SearchResult(photo_id=pid, score=score)
        for pid, score in rows
        if score >= request.threshold
    ]
    return SearchResponse(results=results)


# ---------------------------------------------------------------------------
# /get
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# /quality
# ---------------------------------------------------------------------------

@router.post("/quality", tags=["quality"])
async def compute_quality(file: UploadFile = File(...)) -> dict:
    """Compute an AI quality score (0.0–1.0) for a photo.

    Combines three signals – all computed from already-loaded models/libraries:
    - CLIP text-image similarity against positive/negative quality prompts
    - Laplacian variance (blur) via NumPy (higher variance → sharper image)
    - Mean brightness (exposure) via NumPy (penalise very dark / very bright)

    No new dependencies are required.
    """
    import numpy as np

    try:
        content = await file.read()
        image = Image.open(io.BytesIO(content)).convert("RGB")
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Cannot read image: {exc}",
        ) from exc

    # ── CLIP quality score ──────────────────────────────────────────────────
    try:
        clip_embedder = CLIPEmbedder.get_instance(
            model_name=settings.clip_model_name, pretrained=settings.clip_pretrained
        )
        img_vec = np.array(clip_embedder.embed([image])[0], dtype=np.float32)

        good_prompts = [
            "a sharp in-focus high quality photograph",
            "a well-exposed bright clear photograph",
        ]
        bad_prompts = [
            "a blurry out-of-focus photograph",
            "a dark noisy low quality photo",
        ]

        good_sims = [
            float(np.dot(img_vec, np.array(clip_embedder.embed_text(t), dtype=np.float32)))
            for t in good_prompts
        ]
        bad_sims = [
            float(np.dot(img_vec, np.array(clip_embedder.embed_text(t), dtype=np.float32)))
            for t in bad_prompts
        ]

        clip_diff = sum(good_sims) / len(good_sims) - sum(bad_sims) / len(bad_sims)
        # CLIP cosine diffs cluster in roughly [-0.15, +0.15]; map to [0, 1]
        clip_score = float(max(0.0, min(1.0, (clip_diff + 0.15) / 0.30)))
    except Exception as exc:
        logger.exception("CLIP quality scoring failed")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Quality scoring error",
        ) from exc

    # ── Blur score via Laplacian variance (NumPy only) ──────────────────────
    try:
        sample_size = 256
        gray = image.convert("L").resize((sample_size, sample_size), Image.LANCZOS)
        arr = np.array(gray, dtype=np.float64)
        # Discrete Laplacian: shifted-array approximation
        lap = (
            np.roll(arr, 1, axis=0) + np.roll(arr, -1, axis=0)
            + np.roll(arr, 1, axis=1) + np.roll(arr, -1, axis=1)
            - 4.0 * arr
        )
        blur_variance = float(lap.var())
        # Typical range: blurry photos < 100, sharp photos > 500
        blur_score = float(min(1.0, blur_variance / 500.0))
    except Exception:
        blur_score = 0.5

    # ── Exposure score ──────────────────────────────────────────────────────
    try:
        gray_arr = np.array(image.convert("L"), dtype=np.float64)
        mean_brightness = float(gray_arr.mean()) / 255.0
        # Penalise very dark (<0.2) and very bright (>0.8); peak at 0.5
        exposure_score = float(max(0.0, 1.0 - 2.5 * abs(mean_brightness - 0.5)))
    except Exception:
        exposure_score = 0.5

    # ── Composite ───────────────────────────────────────────────────────────
    composite = 0.4 * clip_score + 0.4 * blur_score + 0.2 * exposure_score

    return {
        "score": round(composite, 4),
        "blur_score": round(blur_score, 4),
        "exposure_score": round(exposure_score, 4),
        "clip_score": round(clip_score, 4),
    }


# ---------------------------------------------------------------------------
# /get
# ---------------------------------------------------------------------------

@router.post("/get", response_model=GetResponse, tags=["embeddings"])
async def get_photos(request: GetRequest, db: DbDep) -> GetResponse:
    """Retrieve embeddings and metadata for a list of photo IDs."""
    photos = await repository.get_photos_by_ids(db, request.photo_ids)

    records = []
    for p in photos:
        records.append(
            PhotoRecord(
                photo_id=p.photo_id,
                file_path=p.file_path,
                timestamp=p.timestamp,
                camera_id=p.camera_id,
                face_ids=p.face_ids,
                embedding_clip=list(p.embedding_clip) if p.embedding_clip is not None else None,
                embedding_dino=list(p.embedding_dino) if p.embedding_dino is not None else None,
                created_at=p.created_at,
            )
        )

    return GetResponse(photos=records)

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

def _clip_dimension_score(img_vec: "np.ndarray", embedder: "CLIPEmbedder", positive: list, negative: list) -> float:
    """Return a [0, 1] score for one quality dimension via CLIP text-image similarity."""
    import numpy as np
    pos_sims = [float(np.dot(img_vec, np.array(embedder.embed_text(t), dtype=np.float32))) for t in positive]
    neg_sims = [float(np.dot(img_vec, np.array(embedder.embed_text(t), dtype=np.float32))) for t in negative]
    diff = sum(pos_sims) / len(pos_sims) - sum(neg_sims) / len(neg_sims)
    # CLIP cosine diffs for image-text pairs cluster roughly in [-0.15, +0.15]
    return float(max(0.0, min(1.0, (diff + 0.15) / 0.30)))


@router.post("/quality", tags=["quality"])
async def compute_quality(
    file: UploadFile = File(...),
    face_bboxes: str = Form(default="[]"),
) -> dict:
    """Compute an AI quality score (0.0–1.0) for a photo.

    Combines six signals – all computed from already-loaded models/libraries:
    - CLIP aesthetics:   text-image similarity for overall aesthetic appeal
    - CLIP composition:  text-image similarity for framing and subject placement
    - CLIP technical:    text-image similarity for sharpness, noise, and exposure
    - Laplacian blur:    NumPy-based blur detection (Laplacian variance)
    - Contrast:          luminance std dev (penalises flat/washed-out images)
    - Exposure:          mean brightness (penalises very dark / very bright)

    No new dependencies are required beyond what the embedding service already uses.
    """
    import numpy as np
    import json

    try:
        content = await file.read()
        image = Image.open(io.BytesIO(content)).convert("RGB")
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Cannot read image: {exc}",
        ) from exc

    try:
        parsed_bboxes = json.loads(face_bboxes)
    except Exception:
        parsed_bboxes = []

    # ── CLIP multi-dimensional aesthetic scoring ────────────────────────────
    try:
        clip_embedder = CLIPEmbedder.get_instance(
            model_name=settings.clip_model_name, pretrained=settings.clip_pretrained
        )
        img_vec = np.array(clip_embedder.embed([image])[0], dtype=np.float32)

        # Dimension 1 – overall aesthetics
        clip_aesthetics = _clip_dimension_score(
            img_vec, clip_embedder,
            positive=[
                "a beautiful aesthetically pleasing photograph",
                "a stunning artistic photo with emotional impact",
            ],
            negative=[
                "an ugly snapshot with no artistic merit",
                "a boring uninteresting photograph",
            ],
        )

        # Dimension 2 – composition and framing
        clip_composition = _clip_dimension_score(
            img_vec, clip_embedder,
            positive=[
                "a well-composed photograph with clear subject and good framing",
                "a photo with balanced composition and pleasing visual flow",
            ],
            negative=[
                "a poorly framed photograph with distracting cluttered background",
                "a photo where the main subject is cut off or poorly positioned",
            ],
        )

        # Dimension 3 – technical quality (sharpness, noise, exposure)
        clip_technical = _clip_dimension_score(
            img_vec, clip_embedder,
            positive=[
                "a sharp in-focus high resolution photograph",
                "a clean crisp photograph with excellent detail",
            ],
            negative=[
                "a blurry out-of-focus grainy photograph",
                "an overexposed washed-out or heavily underexposed dark photo",
            ],
        )
        # ── Eyes-open score via CLIP on face crops ─────────────────────────
        eyes_open_score: float | None = None
        img_w, img_h = image.size
        eyes_scores_list: list[float] = []
        for bbox in parsed_bboxes:
            try:
                bx = float(bbox.get("x", 0))
                by = float(bbox.get("y", 0))
                bw = float(bbox.get("width", 0))
                bh = float(bbox.get("height", 0))
                if bw <= 0 or bh <= 0:
                    continue
                pad = 0.25
                x1 = max(0, int((bx - bw * pad) * img_w))
                y1 = max(0, int((by - bh * pad) * img_h))
                x2 = min(img_w, int((bx + bw * (1 + pad)) * img_w))
                y2 = min(img_h, int((by + bh * (1 + pad)) * img_h))
                if x2 - x1 < 16 or y2 - y1 < 16:
                    continue
                face_crop = image.crop((x1, y1, x2, y2)).resize((224, 224), Image.LANCZOS)
                face_vec = np.array(clip_embedder.embed([face_crop])[0], dtype=np.float32)
                s = _clip_dimension_score(
                    face_vec, clip_embedder,
                    positive=["a person with open eyes looking at the camera", "alert face with clearly open eyes"],
                    negative=["a person with closed eyes blinking", "face with shut eyes asleep or blinking"],
                )
                eyes_scores_list.append(s)
            except Exception:
                continue
        if eyes_scores_list:
            # Use the minimum — if any face has closed eyes the photo is poor
            eyes_open_score = min(eyes_scores_list)

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
        # Discrete Laplacian via shifted-array approximation
        lap = (
            np.roll(arr, 1, axis=0) + np.roll(arr, -1, axis=0)
            + np.roll(arr, 1, axis=1) + np.roll(arr, -1, axis=1)
            - 4.0 * arr
        )
        blur_variance = float(lap.var())
        # Typical range: blurry photos < 100, sharp photos > 500
        blur_score = float(min(1.0, blur_variance / 500.0))

        # ── Face-region sharpness (replaces full-image blur when faces present)
        face_sharpness: float | None = None
        face_sharp_list: list[float] = []
        for bbox in parsed_bboxes:
            try:
                bx = float(bbox.get("x", 0))
                by = float(bbox.get("y", 0))
                bw = float(bbox.get("width", 0))
                bh = float(bbox.get("height", 0))
                if bw <= 0 or bh <= 0:
                    continue
                x1 = max(0, int(bx * img_w))
                y1 = max(0, int(by * img_h))
                x2 = min(img_w, int((bx + bw) * img_w))
                y2 = min(img_h, int((by + bh) * img_h))
                if x2 - x1 < 10 or y2 - y1 < 10:
                    continue
                face_gray = image.crop((x1, y1, x2, y2)).convert("L").resize((128, 128), Image.LANCZOS)
                fa = np.array(face_gray, dtype=np.float64)
                flap = (
                    np.roll(fa, 1, axis=0) + np.roll(fa, -1, axis=0)
                    + np.roll(fa, 1, axis=1) + np.roll(fa, -1, axis=1)
                    - 4.0 * fa
                )
                face_sharp_list.append(float(min(1.0, flap.var() / 500.0)))
            except Exception:
                continue
        if face_sharp_list:
            # Worst face matters most — if any face is blurry the photo is poor
            face_sharpness = min(face_sharp_list)
    except Exception:
        blur_score = 0.5
        face_sharpness = None

    # ── Contrast score (luminance std dev) ─────────────────────────────────
    # Low contrast = flat/washed-out; very high contrast = possibly over-processed.
    # Sweet spot: std dev 40-80 out of 255 → normalised ~0.55-0.80 on a 0-255 scale.
    try:
        gray_arr = np.array(image.convert("L"), dtype=np.float64)
        std_lum = float(gray_arr.std())
        # Map: 0→0, 60→1.0, 120+→0.8 (slight penalty for extreme contrast)
        if std_lum <= 60.0:
            contrast_score = std_lum / 60.0
        else:
            contrast_score = max(0.5, 1.0 - (std_lum - 60.0) / 300.0)
        contrast_score = float(max(0.0, min(1.0, contrast_score)))
    except Exception:
        contrast_score = 0.5

    # ── Exposure score (mean brightness) ────────────────────────────────────
    try:
        gray_arr = np.array(image.convert("L"), dtype=np.float64)
        mean_brightness = float(gray_arr.mean()) / 255.0
        # Penalise very dark (<0.2) and very bright (>0.8); peak at 0.5
        exposure_score = float(max(0.0, 1.0 - 2.5 * abs(mean_brightness - 0.5)))
    except Exception:
        exposure_score = 0.5

    # ── Composite ───────────────────────────────────────────────────────────
    # When face data is available, blend face-region sharpness with full-image
    # blur (face sharpness is a stronger signal for portrait quality).
    effective_blur = (
        0.35 * blur_score + 0.65 * face_sharpness
        if face_sharpness is not None
        else blur_score
    )

    composite = (
        0.30 * clip_aesthetics
        + 0.20 * clip_composition
        + 0.10 * clip_technical
        + 0.25 * effective_blur
        + 0.10 * contrast_score
        + 0.05 * exposure_score
    )

    # Closed-eyes penalty: up to -25 % if eyes are clearly shut
    if eyes_open_score is not None:
        composite *= (0.75 + 0.25 * eyes_open_score)
        composite = min(1.0, composite)

    result: dict = {
        "score": round(composite, 4),
        "clip_aesthetics": round(clip_aesthetics, 4),
        "clip_composition": round(clip_composition, 4),
        "clip_technical": round(clip_technical, 4),
        "blur_score": round(blur_score, 4),
        "contrast_score": round(contrast_score, 4),
        "exposure_score": round(exposure_score, 4),
    }
    if face_sharpness is not None:
        result["face_sharpness"] = round(face_sharpness, 4)
    if eyes_open_score is not None:
        result["eyes_open_score"] = round(eyes_open_score, 4)
    return result


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

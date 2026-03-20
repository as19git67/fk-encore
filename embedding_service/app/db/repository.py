"""Data access layer for photo embeddings."""

from __future__ import annotations

import logging
from typing import List, Optional, Tuple

from sqlalchemy import select, text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.orm_models import Photo

logger = logging.getLogger(__name__)


async def get_existing_photo_ids(session: AsyncSession, photo_ids: List[str]) -> set[str]:
    """Return the subset of photo_ids that already exist in the DB."""
    result = await session.execute(
        select(Photo.photo_id).where(Photo.photo_id.in_(photo_ids))
    )
    return {row[0] for row in result.fetchall()}


async def upsert_photos(session: AsyncSession, photos: List[dict]) -> int:
    """Insert photos, skipping rows whose photo_id already exists.

    Returns the number of rows actually inserted.
    """
    if not photos:
        return 0

    stmt = (
        pg_insert(Photo)
        .values(photos)
        .on_conflict_do_nothing(index_elements=["photo_id"])
    )
    result = await session.execute(stmt)
    await session.flush()
    return result.rowcount


async def get_photos_by_ids(session: AsyncSession, photo_ids: List[str]) -> List[Photo]:
    """Fetch Photo rows for the given IDs."""
    result = await session.execute(
        select(Photo).where(Photo.photo_id.in_(photo_ids))
    )
    return list(result.scalars().all())


async def search_by_clip(
    session: AsyncSession, query_vector: List[float], k: int
) -> List[Tuple[str, float]]:
    """Cosine similarity search using CLIP embeddings."""
    vector_literal = _vector_literal(query_vector)
    sql = text(
        f"""
        SELECT photo_id,
               1 - (embedding_clip <=> '{vector_literal}'::vector) AS score
        FROM photos
        WHERE embedding_clip IS NOT NULL
        ORDER BY embedding_clip <=> '{vector_literal}'::vector
        LIMIT :k
        """
    )
    result = await session.execute(sql, {"k": k})
    return [(row.photo_id, float(row.score)) for row in result.fetchall()]


async def search_by_dino(
    session: AsyncSession, query_vector: List[float], k: int
) -> List[Tuple[str, float]]:
    """Cosine similarity search using DINOv2 embeddings."""
    vector_literal = _vector_literal(query_vector)
    sql = text(
        f"""
        SELECT photo_id,
               1 - (embedding_dino <=> '{vector_literal}'::vector) AS score
        FROM photos
        WHERE embedding_dino IS NOT NULL
        ORDER BY embedding_dino <=> '{vector_literal}'::vector
        LIMIT :k
        """
    )
    result = await session.execute(sql, {"k": k})
    return [(row.photo_id, float(row.score)) for row in result.fetchall()]


def _vector_literal(vector: List[float]) -> str:
    """Convert a Python float list to pgvector literal string."""
    return "[" + ",".join(str(v) for v in vector) + "]"

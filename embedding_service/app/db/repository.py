"""Data access layer for photo embeddings."""

from __future__ import annotations

import logging
from typing import List, Optional, Tuple

from sqlalchemy import String, select, text
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql import bindparam
from sqlalchemy.sql.expression import any_

from app.db.orm_models import Photo

logger = logging.getLogger(__name__)


def _photo_id_any(photo_ids: List[str]):
    """Build a WHERE-clause fragment using PostgreSQL's `= ANY($1)`.

    SQLAlchemy's `.in_(list)` expands to one bound parameter per element,
    which trips asyncpg's hard limit of 32767 parameters per query once the
    list grows large (hit by /similar-groups when an album has ~30k+ photos).
    Binding the whole list as a single text[] array sidesteps the limit.
    """
    return Photo.photo_id == any_(
        bindparam("photo_ids_arr", list(photo_ids), type_=ARRAY(String))
    )


async def get_existing_photo_ids(session: AsyncSession, photo_ids: List[str]) -> set[str]:
    """Return the subset of photo_ids that already exist in the DB."""
    if not photo_ids:
        return set()
    result = await session.execute(
        select(Photo.photo_id).where(_photo_id_any(photo_ids))
    )
    return {row[0] for row in result.fetchall()}


async def upsert_photos(session: AsyncSession, photos: List[dict], overwrite: bool = False) -> int:
    """Insert photos. When overwrite=True, update embeddings on conflict.

    Returns the number of rows actually inserted or updated.
    """
    if not photos:
        return 0

    insert_stmt = pg_insert(Photo).values(photos)
    if overwrite:
        stmt = insert_stmt.on_conflict_do_update(
            index_elements=["photo_id"],
            set_={
                "embedding_clip": insert_stmt.excluded.embedding_clip,
                "embedding_dino": insert_stmt.excluded.embedding_dino,
                "face_ids": insert_stmt.excluded.face_ids,
            },
        )
    else:
        stmt = insert_stmt.on_conflict_do_nothing(index_elements=["photo_id"])
    result = await session.execute(stmt)
    await session.flush()
    return result.rowcount


async def get_photos_by_ids(session: AsyncSession, photo_ids: List[str]) -> List[Photo]:
    """Fetch Photo rows for the given IDs."""
    if not photo_ids:
        return []
    result = await session.execute(
        select(Photo).where(_photo_id_any(photo_ids))
    )
    return list(result.scalars().all())


async def delete_all_photos(session: AsyncSession) -> int:
    """Delete all photo embeddings. Returns the number of rows removed."""
    result = await session.execute(text("DELETE FROM photos"))
    await session.flush()
    return result.rowcount or 0


async def get_dino_embeddings_sorted_by_time(
    session: AsyncSession, photo_ids: List[str]
) -> List[Tuple[str, float, List[float]]]:
    """Fetch (photo_id, timestamp_seconds, embedding_dino) for photos with
    a non-null DINOv2 embedding AND timestamp, ordered by timestamp ascending.

    Rows missing either field are skipped — they can't participate in the
    windowed pair search. Uses the ORM so pgvector's registered type adapter
    produces a clean list from the `vector` column rather than raw driver
    output.
    """
    if not photo_ids:
        return []
    stmt = (
        select(Photo.photo_id, Photo.timestamp, Photo.embedding_dino)
        .where(
            _photo_id_any(photo_ids),
            Photo.embedding_dino.is_not(None),
            Photo.timestamp.is_not(None),
        )
        .order_by(Photo.timestamp.asc())
    )
    result = await session.execute(stmt)
    rows: List[Tuple[str, float, List[float]]] = []
    for photo_id, ts, emb in result.all():
        rows.append((photo_id, ts.timestamp(), list(emb)))
    return rows


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

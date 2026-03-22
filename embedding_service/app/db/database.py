"""Database connection and session management."""

from __future__ import annotations

import logging
from typing import AsyncGenerator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from app.config import settings

logger = logging.getLogger(__name__)

engine = create_async_engine(
    settings.database_url,
    pool_size=settings.db_pool_size,
    max_overflow=settings.db_max_overflow,
    pool_pre_ping=True,
    echo=settings.db_echo,
)

AsyncSessionLocal = async_sessionmaker(
    bind=engine,
    class_=AsyncSession,
    expire_on_commit=False,
    autocommit=False,
    autoflush=False,
)


class Base(DeclarativeBase):
    pass


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """Dependency that provides an async DB session."""
    async with AsyncSessionLocal() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()


async def run_migrations() -> None:
    """Create schema objects if they don't exist yet (idempotent)."""
    from sqlalchemy import text

    statements = [
        "CREATE EXTENSION IF NOT EXISTS vector",
        """
        CREATE TABLE IF NOT EXISTS photos (
            photo_id        TEXT PRIMARY KEY,
            file_path       TEXT NOT NULL,
            timestamp       TIMESTAMP,
            camera_id       TEXT,
            face_ids        TEXT[],
            embedding_clip  VECTOR(512),
            embedding_dino  VECTOR(768),
            created_at      TIMESTAMP DEFAULT NOW()
        )
        """,
        "CREATE INDEX IF NOT EXISTS idx_clip_embedding ON photos USING hnsw (embedding_clip vector_cosine_ops)",
        "CREATE INDEX IF NOT EXISTS idx_dino_embedding ON photos USING hnsw (embedding_dino vector_cosine_ops)",
    ]

    async with engine.begin() as conn:
        for stmt in statements:
            await conn.execute(text(stmt))
    logger.info("Database migrations applied.")


async def check_db_connection() -> bool:
    """Return True if the database is reachable."""
    from sqlalchemy import text

    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
        return True
    except Exception as exc:
        logger.error("DB health check failed: %s", exc)
        return False

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


async def ensure_database_exists() -> None:
    """Create the target database if it does not exist yet."""
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine
    from urllib.parse import urlparse, urlunparse

    url = urlparse(str(settings.database_url))
    target_db = url.path.lstrip("/")
    if not target_db or target_db == "postgres":
        return

    admin_url = urlunparse(url._replace(path="/postgres"))
    admin_engine = create_async_engine(admin_url, isolation_level="AUTOCOMMIT")
    try:
        async with admin_engine.connect() as conn:
            result = await conn.execute(
                text("SELECT 1 FROM pg_database WHERE datname = :db"),
                {"db": target_db},
            )
            if not result.fetchone():
                await conn.execute(text(f'CREATE DATABASE "{target_db}"'))
                logger.info("Created database: %s", target_db)
    finally:
        await admin_engine.dispose()


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
            embedding_clip  VECTOR(768),
            embedding_dino  VECTOR(768),
            created_at      TIMESTAMP DEFAULT NOW()
        )
        """,
        "CREATE INDEX IF NOT EXISTS idx_dino_embedding ON photos USING hnsw (embedding_dino vector_cosine_ops)",
        # Migrate embedding_clip from 512 → 768 on existing installations
        """
        DO $$
        BEGIN
            IF (
                SELECT pg_catalog.format_type(atttypid, atttypmod)
                FROM pg_attribute
                WHERE attrelid = 'photos'::regclass AND attname = 'embedding_clip'
            ) != 'vector(768)' THEN
                ALTER TABLE photos ALTER COLUMN embedding_clip TYPE vector(768);
                DROP INDEX IF EXISTS idx_clip_embedding;
                CREATE INDEX idx_clip_embedding ON photos USING hnsw (embedding_clip vector_cosine_ops);
            END IF;
        END$$;
        """,
        "CREATE INDEX IF NOT EXISTS idx_clip_embedding ON photos USING hnsw (embedding_clip vector_cosine_ops)",
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

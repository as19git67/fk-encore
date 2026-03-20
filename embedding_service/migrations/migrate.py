#!/usr/bin/env python3
"""Standalone migration runner – applies SQL migration files in order.

Usage:
    python migrations/migrate.py
    DATABASE_URL=postgresql://user:pass@host/db python migrations/migrate.py
"""

from __future__ import annotations

import asyncio
import logging
import os
from pathlib import Path

import asyncpg

logger = logging.getLogger(__name__)
logging.basicConfig(level="INFO", format="%(asctime)s | %(levelname)s | %(message)s")

MIGRATIONS_DIR = Path(__file__).parent


async def run_migrations() -> None:
    # Support both asyncpg-style URL and SQLAlchemy-style URL
    db_url = os.environ.get("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/embeddings")
    db_url = db_url.replace("postgresql+asyncpg://", "postgresql://")

    logger.info("Connecting to %s", db_url)
    conn = await asyncpg.connect(db_url)

    try:
        # Ensure tracking table exists
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS schema_migrations (
                filename TEXT PRIMARY KEY,
                applied_at TIMESTAMP DEFAULT NOW()
            )
            """
        )

        sql_files = sorted(MIGRATIONS_DIR.glob("*.sql"))
        for sql_file in sql_files:
            already_applied = await conn.fetchval(
                "SELECT 1 FROM schema_migrations WHERE filename = $1", sql_file.name
            )
            if already_applied:
                logger.info("Skipping already-applied migration: %s", sql_file.name)
                continue

            logger.info("Applying migration: %s", sql_file.name)
            sql = sql_file.read_text()
            await conn.execute(sql)
            await conn.execute(
                "INSERT INTO schema_migrations (filename) VALUES ($1)", sql_file.name
            )
            logger.info("Applied: %s", sql_file.name)

        logger.info("All migrations applied.")
    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(run_migrations())

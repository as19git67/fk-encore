"""SQLAlchemy ORM model for the photos table."""

from __future__ import annotations

from datetime import datetime
from typing import List, Optional

from pgvector.sqlalchemy import Vector
from sqlalchemy import ARRAY, TIMESTAMP, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.database import Base


class Photo(Base):
    __tablename__ = "photos"

    photo_id: Mapped[str] = mapped_column(String, primary_key=True)
    file_path: Mapped[str] = mapped_column(Text, nullable=False)
    timestamp: Mapped[Optional[datetime]] = mapped_column(TIMESTAMP(timezone=False), nullable=True)
    camera_id: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    face_ids: Mapped[Optional[List[str]]] = mapped_column(ARRAY(String), nullable=True)
    embedding_clip: Mapped[Optional[list]] = mapped_column(Vector(768), nullable=True)
    embedding_dino: Mapped[Optional[list]] = mapped_column(Vector(768), nullable=True)
    created_at: Mapped[Optional[datetime]] = mapped_column(
        TIMESTAMP(timezone=False), server_default=func.now(), nullable=True
    )

"""Pydantic schemas for request/response models."""

from __future__ import annotations

from datetime import datetime
from typing import List, Optional

from pydantic import BaseModel, Field


class PhotoInput(BaseModel):
    photo_id: str = Field(..., description="Unique identifier for the photo")
    file_path: str = Field(..., description="Absolute path to the image file")
    timestamp: Optional[datetime] = Field(None, description="Photo capture timestamp")
    camera_id: Optional[str] = Field(None, description="Camera identifier")
    face_ids: Optional[List[str]] = Field(default_factory=list, description="List of face identifiers")


class EmbedRequest(BaseModel):
    photos: List[PhotoInput] = Field(..., min_length=1, description="Batch of photos to embed")


class EmbedResponse(BaseModel):
    status: str = Field(default="ok")
    processed: int = Field(..., description="Number of photos successfully processed")


class SearchRequest(BaseModel):
    photo_id: str = Field(..., description="photo_id whose embedding is used as query")
    k: int = Field(default=10, ge=1, le=100, description="Number of nearest neighbours to return")
    mode: str = Field(default="clip", pattern="^(clip|dino|hybrid)$", description="Similarity mode")


class TextSearchRequest(BaseModel):
    query: str = Field(..., min_length=1, max_length=500, description="Natural language search query")
    k: int = Field(default=20, ge=1, le=100, description="Number of nearest neighbours to return")
    threshold: float = Field(default=0.20, ge=0.0, le=1.0, description="Minimum cosine similarity score")


class SearchResult(BaseModel):
    photo_id: str
    score: float


class SearchResponse(BaseModel):
    results: List[SearchResult]


class GetRequest(BaseModel):
    photo_ids: List[str] = Field(..., min_length=1)


class PhotoRecord(BaseModel):
    photo_id: str
    file_path: str
    timestamp: Optional[datetime]
    camera_id: Optional[str]
    face_ids: Optional[List[str]]
    embedding_clip: Optional[List[float]]
    embedding_dino: Optional[List[float]]
    created_at: Optional[datetime]

    class Config:
        from_attributes = True


class GetResponse(BaseModel):
    photos: List[PhotoRecord]


class HealthResponse(BaseModel):
    status: str
    db: str
    models: dict

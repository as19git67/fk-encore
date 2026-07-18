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


class DinoEmbedResponse(BaseModel):
    """Response payload of /dino/embed — a single DINOv2 vector, no
    persistence side-effect. Used by the POI-detection pipeline to
    embed external reference images (Wikimedia Commons P18 photos)
    without polluting the photo embeddings table."""

    embedding: List[float] = Field(..., description="DINOv2 vector (length 768 for the default base model)")
    dim: int = Field(..., description="Vector dimension")


class SearchRequest(BaseModel):
    photo_id: str = Field(..., description="photo_id whose embedding is used as query")
    k: int = Field(default=10, ge=1, le=100, description="Number of nearest neighbours to return")
    mode: str = Field(default="clip", pattern="^(clip|dino|hybrid)$", description="Similarity mode")


class TextSearchRequest(BaseModel):
    query: str = Field(..., min_length=1, max_length=500, description="Natural language search query")
    k: int = Field(default=20, ge=1, le=1000, description="Number of nearest neighbours to return")
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


class ParseQueryRequest(BaseModel):
    query: str = Field(..., min_length=1, max_length=500, description="Natural language query in German")


class ParseQueryResponse(BaseModel):
    semantic_query: str = Field(..., description="Cleaned text suitable for CLIP text encoding")
    location: Optional[str] = Field(None, description="Detected location (city, country, region)")
    from_date: Optional[str] = Field(None, description="ISO 8601 start date, inclusive")
    to_date: Optional[str] = Field(None, description="ISO 8601 end date, inclusive")


class SimilarGroupsRequest(BaseModel):
    photo_ids: List[str] = Field(..., min_length=2, description="Photo IDs to consider for grouping")
    threshold: float = Field(default=0.90, ge=0.0, le=1.0, description="Minimum cosine similarity for a pair")
    time_window_seconds: int = Field(default=600, ge=0, description="Max seconds between capture times for a pair to count")


class SimilarGroupMember(BaseModel):
    photo_id: str
    similarity_rank: int = Field(..., description="0 = cover photo (medoid)")
    similarity_score: float = Field(..., ge=-1.0, le=1.0, description="Cosine similarity to the group medoid")


class SimilarGroup(BaseModel):
    cover_photo_id: str
    members: List[SimilarGroupMember]


class SimilarGroupsResponse(BaseModel):
    groups: List[SimilarGroup]


class DiverseSelectItem(BaseModel):
    photo_id: str
    quality: float = Field(default=0.0, description="AI quality score; higher is better")
    cluster: int = Field(default=0, description="Location cluster label; picks are spread across clusters")


class DiverseSelectRequest(BaseModel):
    items: List[DiverseSelectItem] = Field(..., min_length=1, description="Candidate photos to choose from")
    count: int = Field(..., ge=1, description="Target number of photos to return")
    similarity_threshold: float = Field(
        default=0.82,
        ge=0.0,
        le=1.0,
        description="Skip a candidate whose cosine similarity to an already-chosen photo reaches this",
    )


class DiverseSelectResponse(BaseModel):
    photo_ids: List[str] = Field(..., description="Chosen photo ids, best-first (index 0 is the cover)")


class ScenePairCandidate(BaseModel):
    photo_id: str
    timestamp: float = Field(..., description="Unix epoch seconds of capture time")
    quality: float = Field(default=0.0, description="AI quality score; used to pick the best pair per scene")


class FindScenePairsRequest(BaseModel):
    candidates: List[ScenePairCandidate] = Field(..., min_length=2, description="Candidate photos to scan for scene pairs")
    min_time_gap_days: int = Field(default=730, ge=30, description="Minimum days between the two photos of a pair")
    similarity_threshold: float = Field(default=0.70, ge=0.0, le=1.0, description="Minimum DINOv2 cosine similarity for a match")
    max_pairs: int = Field(default=10, ge=1, le=50, description="Maximum number of scene pairs to return")


class ScenePair(BaseModel):
    photo_id_then: str
    photo_id_now: str
    similarity: float
    time_gap_days: int


class FindScenePairsResponse(BaseModel):
    pairs: List[ScenePair]

"""Tests for Pydantic request/response schemas."""

import pytest
from datetime import datetime, timezone
from pydantic import ValidationError

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.models.schemas import (
    PhotoInput,
    EmbedRequest,
    EmbedResponse,
    SearchRequest,
    TextSearchRequest,
    SearchResult,
    SearchResponse,
    GetRequest,
    PhotoRecord,
    GetResponse,
    HealthResponse,
)


class TestPhotoInput:
    def test_valid_minimal(self):
        p = PhotoInput(photo_id="p1", file_path="/tmp/photo.jpg")
        assert p.photo_id == "p1"
        assert p.file_path == "/tmp/photo.jpg"
        assert p.timestamp is None
        assert p.camera_id is None
        assert p.face_ids == []

    def test_valid_full(self):
        ts = datetime(2024, 6, 1, 12, 0, 0)
        p = PhotoInput(
            photo_id="p2",
            file_path="/data/img.jpg",
            timestamp=ts,
            camera_id="cam-1",
            face_ids=["f1", "f2"],
        )
        assert p.timestamp == ts
        assert p.face_ids == ["f1", "f2"]

    def test_missing_required_fields(self):
        with pytest.raises(ValidationError):
            PhotoInput(photo_id="p1")  # file_path missing

        with pytest.raises(ValidationError):
            PhotoInput(file_path="/tmp/x.jpg")  # photo_id missing


class TestEmbedRequest:
    def test_valid_single_photo(self):
        req = EmbedRequest(photos=[PhotoInput(photo_id="p1", file_path="/tmp/a.jpg")])
        assert len(req.photos) == 1

    def test_valid_multiple_photos(self):
        photos = [PhotoInput(photo_id=f"p{i}", file_path=f"/tmp/{i}.jpg") for i in range(5)]
        req = EmbedRequest(photos=photos)
        assert len(req.photos) == 5

    def test_empty_photos_rejected(self):
        with pytest.raises(ValidationError):
            EmbedRequest(photos=[])

    def test_missing_photos_rejected(self):
        with pytest.raises(ValidationError):
            EmbedRequest()


class TestEmbedResponse:
    def test_defaults(self):
        r = EmbedResponse(processed=3)
        assert r.status == "ok"
        assert r.processed == 3

    def test_custom_status(self):
        r = EmbedResponse(status="error", processed=0)
        assert r.status == "error"


class TestSearchRequest:
    def test_defaults(self):
        req = SearchRequest(photo_id="p1")
        assert req.k == 10
        assert req.mode == "clip"

    def test_valid_modes(self):
        for mode in ("clip", "dino", "hybrid"):
            req = SearchRequest(photo_id="p1", mode=mode)
            assert req.mode == mode

    def test_invalid_mode(self):
        with pytest.raises(ValidationError):
            SearchRequest(photo_id="p1", mode="invalid")

    def test_k_boundaries(self):
        SearchRequest(photo_id="p1", k=1)
        SearchRequest(photo_id="p1", k=100)
        with pytest.raises(ValidationError):
            SearchRequest(photo_id="p1", k=0)
        with pytest.raises(ValidationError):
            SearchRequest(photo_id="p1", k=101)


class TestTextSearchRequest:
    def test_defaults(self):
        req = TextSearchRequest(query="sunset beach")
        assert req.k == 20
        assert req.threshold == pytest.approx(0.20)

    def test_empty_query_rejected(self):
        with pytest.raises(ValidationError):
            TextSearchRequest(query="")

    def test_query_too_long_rejected(self):
        with pytest.raises(ValidationError):
            TextSearchRequest(query="x" * 501)

    def test_threshold_boundaries(self):
        TextSearchRequest(query="q", threshold=0.0)
        TextSearchRequest(query="q", threshold=1.0)
        with pytest.raises(ValidationError):
            TextSearchRequest(query="q", threshold=-0.1)
        with pytest.raises(ValidationError):
            TextSearchRequest(query="q", threshold=1.1)


class TestSearchResponse:
    def test_empty_results(self):
        resp = SearchResponse(results=[])
        assert resp.results == []

    def test_with_results(self):
        results = [SearchResult(photo_id="p1", score=0.95), SearchResult(photo_id="p2", score=0.80)]
        resp = SearchResponse(results=results)
        assert len(resp.results) == 2
        assert resp.results[0].score == pytest.approx(0.95)


class TestGetRequest:
    def test_valid(self):
        req = GetRequest(photo_ids=["p1", "p2"])
        assert req.photo_ids == ["p1", "p2"]

    def test_empty_list_rejected(self):
        with pytest.raises(ValidationError):
            GetRequest(photo_ids=[])


class TestHealthResponse:
    def test_ok_status(self):
        r = HealthResponse(status="ok", db="ok", models={"clip": "loaded", "dino": "loaded"})
        assert r.status == "ok"
        assert r.db == "ok"
        assert r.models["clip"] == "loaded"

    def test_degraded_status(self):
        r = HealthResponse(status="degraded", db="error", models={})
        assert r.status == "degraded"

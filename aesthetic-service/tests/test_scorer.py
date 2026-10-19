"""The parts of the real scorer that run without torch."""

from __future__ import annotations

from pathlib import Path

import pytest

import scorer


def test_rejects_an_unknown_quantization():
    with pytest.raises(scorer.ScorerError, match="quantization"):
        scorer.QAlignScorer(quantization="3bit")


def test_env_factory_reads_its_settings(monkeypatch):
    monkeypatch.setenv("MODELS_DIR", "/tmp/models")
    monkeypatch.delenv("HF_HOME", raising=False)
    monkeypatch.setenv("AESTHETIC_DEVICE", "cpu")
    monkeypatch.setenv("AESTHETIC_QUANT", "4bit")
    s = scorer.scorer_from_env()
    assert s.model_id == scorer.DEFAULT_MODEL_ID
    assert s.cache_dir == Path("/tmp/models/hf-cache")
    assert s.device == "cpu"
    assert s.quantization == "4bit"
    assert s.version == scorer.SCORER_VERSION


def test_unloaded_scorer_refuses_to_score_and_unloads_quietly():
    s = scorer.QAlignScorer(device="cpu")
    with pytest.raises(scorer.ScorerError, match="not loaded"):
        s.score(object())
    s.unload()  # nothing loaded: a no-op, never an error


def test_scores_are_clamped_to_the_model_cards_range():
    assert scorer._clamp(0.2) == 1.0
    assert scorer._clamp(7.0) == 5.0
    assert scorer._clamp(3.3) == 3.3

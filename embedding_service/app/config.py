"""Application configuration loaded from environment variables."""

from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # Database
    database_url: str = "postgresql+asyncpg://postgres:postgres@localhost:5432/embeddings"
    db_pool_size: int = 5
    db_max_overflow: int = 10
    db_echo: bool = False

    # CLIP model – multilingual ViT-H-14 (XLM-RoBERTa-Large text encoder, 1024-dim)
    clip_model_name: str = "xlm-roberta-large-ViT-H-14"
    clip_pretrained: str = "frozen_laion5b_s13b_b90k"

    # DINOv2 model
    dino_model_name: str = "facebook/dinov2-base"

    # Lazy loading models (default: false, meaning preloading is the default)
    lazy_load_models: bool = False

    # Inference backend selector. "torch" runs the original PyTorch path
    # (CLIP H/14 + DINOv2-base in fp32). "onnx" runs the ONNX/INT8 path
    # produced by app/scripts/export_onnx.py — INT8 for the heavy CLIP
    # visual tower, fp32 ONNX for CLIP text + DINOv2 (see the OnnxInt8Backend
    # for the quality rationale). Switching to "onnx" requires the ONNX
    # artefacts to be present in ${MODELS_DIR}/onnx/ — run
    # /usr/local/bin/optimize_models.sh once before flipping. Defaults to
    # "torch" so an upgraded image with a not-yet-populated volume keeps
    # working.
    embed_backend: str = "torch"

    # Logging
    log_level: str = "INFO"

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")


settings = Settings()

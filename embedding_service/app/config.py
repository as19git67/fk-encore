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

    # Logging
    log_level: str = "INFO"

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")


settings = Settings()

"""Lazy-loaded singleton embedding service (OpenCLIP + DINOv2).

Two interchangeable backends are exposed through the same `.get_instance()`
+ `.embed()` / `.embed_text()` API so callers (FastAPI endpoints, eval
script, future tooling) don't need to care which one is active:

  - CLIPEmbedder / DINOv2Embedder           — original PyTorch path, fp32
  - OnnxClipEmbedder / OnnxDinoEmbedder     — INT8/fp32 ONNX path

Pick at startup via the `embed_backend` setting (env: EMBED_BACKEND).
The factory functions `clip_embedder_class()` / `dino_embedder_class()`
encapsulate the dispatch so the rest of the codebase stays oblivious.
"""

from __future__ import annotations

import logging
from typing import List, Optional, Type

import numpy as np
import torch
from PIL import Image

from app.config import settings

logger = logging.getLogger(__name__)


def _get_device() -> torch.device:
    return torch.device("cuda" if torch.cuda.is_available() else "cpu")


class CLIPEmbedder:
    """OpenCLIP image embedder (singleton)."""

    _instance: Optional["CLIPEmbedder"] = None

    def __init__(self, model_name: str = "ViT-B-32", pretrained: str = "openai") -> None:
        import open_clip

        device = _get_device()
        logger.info("Loading OpenCLIP model '%s' (pretrained=%s) on %s", model_name, pretrained, device)
        self.model_name = model_name
        self.model, _, self.preprocess = open_clip.create_model_and_transforms(
            model_name, pretrained=pretrained
        )
        self.model = self.model.to(device).eval()
        self.device = device
        logger.info("OpenCLIP model loaded.")

    @classmethod
    def get_instance(cls, model_name: str = "ViT-B-32", pretrained: str = "openai") -> "CLIPEmbedder":
        if cls._instance is None:
            cls._instance = cls(model_name=model_name, pretrained=pretrained)
        return cls._instance

    @classmethod
    async def preload(cls, model_name: str = "ViT-B-32", pretrained: str = "openai") -> None:
        """Explicitly load the CLIP model into memory."""
        cls.get_instance(model_name=model_name, pretrained=pretrained)

    @torch.no_grad()
    def embed(self, images: List[Image.Image]) -> List[List[float]]:
        """Return normalized CLIP embeddings for a list of PIL Image objects."""
        preprocessed_images = [self.preprocess(img.convert("RGB")) for img in images]
        batch = torch.stack(preprocessed_images).to(self.device)
        features = self.model.encode_image(batch)
        features = features / features.norm(dim=-1, keepdim=True)
        return features.cpu().float().tolist()

    @torch.no_grad()
    def embed_text(self, text: str) -> List[float]:
        """Return a normalized CLIP text embedding for a natural language query."""
        import open_clip
        tokenizer = open_clip.get_tokenizer(self.model_name)
        tokens = tokenizer([text]).to(self.device)
        features = self.model.encode_text(tokens)
        features = features / features.norm(dim=-1, keepdim=True)
        return features[0].cpu().float().tolist()


class DINOv2Embedder:
    """DINOv2 image embedder (singleton)."""

    _instance: Optional["DINOv2Embedder"] = None

    def __init__(self, model_name: str = "facebook/dinov2-base") -> None:
        from transformers import AutoImageProcessor, AutoModel

        device = _get_device()
        logger.info("Loading DINOv2 model '%s' on %s", model_name, device)
        self.processor = AutoImageProcessor.from_pretrained(model_name)
        self.model = AutoModel.from_pretrained(model_name).to(device).eval()
        self.device = device
        logger.info("DINOv2 model loaded.")

    @classmethod
    def get_instance(cls, model_name: str = "facebook/dinov2-base") -> "DINOv2Embedder":
        if cls._instance is None:
            cls._instance = cls(model_name=model_name)
        return cls._instance

    @classmethod
    async def preload(cls, model_name: str = "facebook/dinov2-base") -> None:
        """Explicitly load the DINOv2 model into memory."""
        cls.get_instance(model_name=model_name)

    @torch.no_grad()
    def embed(self, images: List[Image.Image]) -> List[List[float]]:
        """Return normalized DINOv2 CLS-token embeddings for a list of PIL Image objects."""
        inputs = self.processor(images=[img.convert("RGB") for img in images], return_tensors="pt")
        inputs = {k: v.to(self.device) for k, v in inputs.items()}
        outputs = self.model(**inputs)
        # CLS token is the first token
        cls_features = outputs.last_hidden_state[:, 0, :]
        cls_features = cls_features / cls_features.norm(dim=-1, keepdim=True)
        return cls_features.cpu().float().tolist()


# ---------------------------------------------------------------------------
# ONNX/INT8 adapters — same surface as the torch classes above, backed by
# a single shared OnnxInt8Backend so the three ORT sessions only load once
# even though both adapters are independently instantiable singletons.
# ---------------------------------------------------------------------------


_SHARED_ONNX_BACKEND: Optional[object] = None


def _get_shared_onnx_backend():
    """Singleton accessor for OnnxInt8Backend so OnnxClipEmbedder and
    OnnxDinoEmbedder share a single (~1.5 GB) backend instance.
    """
    global _SHARED_ONNX_BACKEND
    if _SHARED_ONNX_BACKEND is None:
        # Local import keeps `torch`-only deployments unaffected by missing
        # onnxruntime; only the onnx codepath pays the import cost.
        from app.services.onnx_backend import OnnxInt8Backend

        _SHARED_ONNX_BACKEND = OnnxInt8Backend()
    return _SHARED_ONNX_BACKEND


class OnnxClipEmbedder:
    """ONNX/INT8-backed CLIP image + text embedder. Same API as CLIPEmbedder."""

    _instance: Optional["OnnxClipEmbedder"] = None

    def __init__(self, model_name: str = "xlm-roberta-large-ViT-H-14", pretrained: str = "frozen_laion5b_s13b_b90k") -> None:
        # The ONNX backend reads the model name / pretrained tag from env;
        # we accept the kwargs purely to mirror CLIPEmbedder's signature so
        # callers can swap classes without touching their call sites.
        self.model_name = model_name
        self.pretrained = pretrained
        self._backend = _get_shared_onnx_backend()

    @classmethod
    def get_instance(cls, model_name: str = "xlm-roberta-large-ViT-H-14", pretrained: str = "frozen_laion5b_s13b_b90k") -> "OnnxClipEmbedder":
        if cls._instance is None:
            cls._instance = cls(model_name=model_name, pretrained=pretrained)
        return cls._instance

    @classmethod
    async def preload(cls, model_name: str = "xlm-roberta-large-ViT-H-14", pretrained: str = "frozen_laion5b_s13b_b90k") -> None:
        """Force-load all ORT sessions + preprocessors."""
        instance = cls.get_instance(model_name=model_name, pretrained=pretrained)
        instance._backend.preload()

    def embed(self, images: List[Image.Image]) -> List[List[float]]:
        return self._backend.embed_image_clip(images).tolist()

    def embed_text(self, text: str) -> List[float]:
        return self._backend.embed_text_clip(text).tolist()


class OnnxDinoEmbedder:
    """ONNX/INT8-backed DINOv2 embedder. Same API as DINOv2Embedder."""

    _instance: Optional["OnnxDinoEmbedder"] = None

    def __init__(self, model_name: str = "facebook/dinov2-base") -> None:
        self.model_name = model_name
        self._backend = _get_shared_onnx_backend()

    @classmethod
    def get_instance(cls, model_name: str = "facebook/dinov2-base") -> "OnnxDinoEmbedder":
        if cls._instance is None:
            cls._instance = cls(model_name=model_name)
        return cls._instance

    @classmethod
    async def preload(cls, model_name: str = "facebook/dinov2-base") -> None:
        instance = cls.get_instance(model_name=model_name)
        instance._backend.preload()

    def embed(self, images: List[Image.Image]) -> List[List[float]]:
        return self._backend.embed_image_dino(images).tolist()


# ---------------------------------------------------------------------------
# Factory — picks Torch or Onnx based on settings.embed_backend.
# Callers do `clip_embedder_class().get_instance(...)`; the dispatch is
# evaluated at call time so a runtime change to settings is honoured.
# ---------------------------------------------------------------------------


def clip_embedder_class() -> Type:
    if settings.embed_backend.lower() == "onnx":
        return OnnxClipEmbedder
    return CLIPEmbedder


def dino_embedder_class() -> Type:
    if settings.embed_backend.lower() == "onnx":
        return OnnxDinoEmbedder
    return DINOv2Embedder

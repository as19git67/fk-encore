"""Lazy-loaded singleton embedding service (OpenCLIP + DINOv2)."""

from __future__ import annotations

import logging
from typing import List, Optional

import numpy as np
import torch
from PIL import Image

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

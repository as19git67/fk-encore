"""ONNX/INT8 inference backend, mirrors the public surface of the torch
CLIPEmbedder + DINOv2Embedder so it can stand in for them in the A/B eval
and (later) in the production embed pipeline.

Design notes:
- Three independent ONNX sessions (CLIP image, CLIP text, DINOv2). Each
  is loaded lazily on first use so a caller that only needs one path
  doesn't pay for the others.
- Pre-processing reuses OpenCLIP's `image_transform` factory and
  `get_tokenizer` for the CLIP side, and HuggingFace's AutoImageProcessor
  for DINOv2 — exactly what the torch path uses, so the A/B test compares
  inference numerics, not preprocessing artefacts.
- Outputs are unit-normalised inside the ONNX graph (we baked that into
  the wrapper at export time), so callers don't need to renormalise.
- `intra_op_num_threads` is set explicitly to keep ORT inside the
  cpuset="0-11" mask the production container runs under.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import List, Optional

import numpy as np
from PIL import Image

logger = logging.getLogger(__name__)


# OpenAI dataset normalisation — ViT-H-14 (frozen_laion5b_s13b_b90k) uses
# this. Keeping the values explicit avoids a soft dependency on open_clip's
# internal constants and matches what gets baked into the torch path.
_OPENAI_MEAN = (0.48145466, 0.4578275, 0.40821073)
_OPENAI_STD = (0.26862954, 0.26130258, 0.27577711)
_CLIP_IMAGE_SIZE = 224


def _default_thread_count() -> int:
    return max(1, (os.cpu_count() or 2) // 2)


_DEFAULT_THREADS = int(os.environ.get("EMBED_NUM_THREADS") or _default_thread_count())


def _make_session_options(threads: int):
    """SessionOptions tuned for the production container.

    intra_op_num_threads must be set explicitly: ORT otherwise fans out
    to logical-CPU count, which fights the container's cpuset and produces
    "pthread_setaffinity_np failed" warnings. inter_op stays at 1 because
    operator-level parallelism rarely helps on transformer graphs and adds
    scheduling overhead.
    """
    import onnxruntime as ort

    opts = ort.SessionOptions()
    opts.intra_op_num_threads = threads
    opts.inter_op_num_threads = 1
    return opts


class OnnxInt8Backend:
    """Drop-in replacement for the torch CLIP+DINOv2 path that runs the
    INT8-quantised ONNX graphs from app/scripts/export_onnx.py.

    Public API mirrors what TorchBackend in quantization_eval.py expects:
      embed_image_clip(images: list[PIL.Image]) -> ndarray (N, 1024)
      embed_image_dino(images: list[PIL.Image]) -> ndarray (N, 768)
      embed_text_clip(query: str) -> ndarray (1024,)

    All outputs are unit-normalised (the ONNX graph does that internally).
    """

    name = "onnx-int8"

    def __init__(
        self,
        onnx_dir: Optional[Path] = None,
        clip_model_name: Optional[str] = None,
        dino_model_name: Optional[str] = None,
        threads: int = _DEFAULT_THREADS,
    ) -> None:
        self.onnx_dir = Path(onnx_dir or os.environ.get("MODELS_DIR", "/models")) / "onnx"
        self.clip_model_name = clip_model_name or os.environ.get(
            "CLIP_MODEL_NAME", "xlm-roberta-large-ViT-H-14"
        )
        self.dino_model_name = dino_model_name or os.environ.get(
            "DINO_MODEL_NAME", "facebook/dinov2-base"
        )
        self.threads = threads

        self._clip_image_session = None
        self._clip_text_session = None
        self._dino_session = None
        self._clip_preprocess = None  # torchvision Compose
        self._clip_tokenizer = None
        self._dino_processor = None

        self._validate_artefacts()

    # ------------------------------------------------------------------
    # Setup
    # ------------------------------------------------------------------

    def _validate_artefacts(self) -> None:
        """Fail loudly at construction time if the operator forgot
        `optimize_models.sh`. Saves a confusing ORT error five layers
        deep when the first inference call hits a missing file.
        """
        for fname in ("clip_image_int8.onnx", "clip_text_int8.onnx", "dinov2_int8.onnx"):
            path = self.onnx_dir / fname
            if not path.exists() or path.stat().st_size == 0:
                raise FileNotFoundError(
                    f"ONNX/INT8 artefact missing: {path}. "
                    f"Run `/usr/local/bin/optimize_models.sh` to populate {self.onnx_dir}."
                )

    def _load_clip_image(self):
        if self._clip_image_session is None:
            import onnxruntime as ort

            path = self.onnx_dir / "clip_image_int8.onnx"
            logger.info("loading ONNX session: %s", path.name)
            self._clip_image_session = ort.InferenceSession(
                str(path),
                _make_session_options(self.threads),
                providers=["CPUExecutionProvider"],
            )
        return self._clip_image_session

    def _load_clip_text(self):
        if self._clip_text_session is None:
            import onnxruntime as ort

            path = self.onnx_dir / "clip_text_int8.onnx"
            logger.info("loading ONNX session: %s", path.name)
            self._clip_text_session = ort.InferenceSession(
                str(path),
                _make_session_options(self.threads),
                providers=["CPUExecutionProvider"],
            )
        return self._clip_text_session

    def _load_dino(self):
        if self._dino_session is None:
            import onnxruntime as ort

            path = self.onnx_dir / "dinov2_int8.onnx"
            logger.info("loading ONNX session: %s", path.name)
            self._dino_session = ort.InferenceSession(
                str(path),
                _make_session_options(self.threads),
                providers=["CPUExecutionProvider"],
            )
        return self._dino_session

    def _load_clip_preprocess(self):
        if self._clip_preprocess is None:
            # image_transform builds a torchvision Compose; no model weights
            # are loaded. Calling it on a PIL Image returns a (3,224,224)
            # torch tensor that we convert to numpy in embed_image_clip.
            from open_clip.transform import image_transform

            self._clip_preprocess = image_transform(
                image_size=_CLIP_IMAGE_SIZE,
                is_train=False,
                mean=_OPENAI_MEAN,
                std=_OPENAI_STD,
            )
        return self._clip_preprocess

    def _load_clip_tokenizer(self):
        if self._clip_tokenizer is None:
            import open_clip

            self._clip_tokenizer = open_clip.get_tokenizer(self.clip_model_name)
        return self._clip_tokenizer

    def _load_dino_processor(self):
        if self._dino_processor is None:
            from transformers import AutoImageProcessor

            self._dino_processor = AutoImageProcessor.from_pretrained(self.dino_model_name)
        return self._dino_processor

    # ------------------------------------------------------------------
    # Inference (mirrors the torch CLIPEmbedder / DINOv2Embedder API)
    # ------------------------------------------------------------------

    def embed_image_clip(self, images: List[Image.Image]) -> np.ndarray:
        """Returns (N, 1024) unit-normalised CLIP image features."""
        if not images:
            return np.zeros((0, 1024), dtype=np.float32)

        preprocess = self._load_clip_preprocess()
        # torchvision Compose returns torch.Tensor; .numpy() avoids a
        # cross-framework dance later in the pipeline.
        batch = np.stack(
            [preprocess(img.convert("RGB")).numpy() for img in images]
        ).astype(np.float32)

        sess = self._load_clip_image()
        out = sess.run(None, {"pixel_values": batch})[0]
        return out.astype(np.float32)

    def embed_image_dino(self, images: List[Image.Image]) -> np.ndarray:
        """Returns (N, 768) unit-normalised DINOv2 CLS features."""
        if not images:
            return np.zeros((0, 768), dtype=np.float32)

        processor = self._load_dino_processor()
        # `return_tensors="np"` lets us skip the torch round-trip entirely.
        inputs = processor(images=[img.convert("RGB") for img in images], return_tensors="np")
        pixel_values = inputs["pixel_values"].astype(np.float32)

        sess = self._load_dino()
        out = sess.run(None, {"pixel_values": pixel_values})[0]
        return out.astype(np.float32)

    def embed_text_clip(self, query: str) -> np.ndarray:
        """Returns a (1024,) unit-normalised CLIP text feature."""
        tokenizer = self._load_clip_tokenizer()
        # OpenCLIP tokenizers accept a list of strings; output is torch.Tensor.
        tokens = tokenizer([query]).numpy().astype(np.int64)

        sess = self._load_clip_text()
        out = sess.run(None, {"input_ids": tokens})[0]  # (1, 1024)
        return out[0].astype(np.float32)

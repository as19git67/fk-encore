"""The Q-Align scorer behind the service.

Q-Align (Wu et al., ICML 2024; Hugging Face ``q-future/one-align``, MIT) is
an mPLUG-Owl2 language model taught to rate an image on five text levels
("bad" … "excellent"); its ``score()`` turns the level probabilities into a
number in [1, 5]. It is the strongest published aesthetic scorer (AVA SRCC
0.82) and the reason this service exists; see
``documentation/plans/foto-aesthetik.md``.

The model is a PyTorch/transformers model, not a GGUF, so it cannot ride
along in the llm-service's llama-server. It is also too large to share the
16 GB card with Gemma 4, which is why the service holds it only while the
nightly job has borrowed the GPU: ``load()`` on demand, ``unload()`` when
the window closes, nothing resident in between.

Everything heavy is imported lazily inside ``QAlignScorer`` so the service,
its tests and the CI smoke test can import this module on a machine without
torch, and so the first request never pays for an import the health check
does not need.
"""

from __future__ import annotations

import gc
import logging
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

log = logging.getLogger("aesthetic-service.scorer")

# The model card's own range; the service reports raw values and lets the
# caller scale, so a reader of ``ai_quality_details`` can tell a 1–5 Q-Align
# score from a 0–1 CLIP one by the version string alone.
SCORE_MIN = 1.0
SCORE_MAX = 5.0

DEFAULT_MODEL_ID = "q-future/one-align"
# Bumped whenever the model, its quantisation or the preprocessing changes
# in a way that makes old scores incomparable. The photo service writes it
# to ``ai_quality_details.aesthetic_model`` and the nightly job re-scores
# anything carrying an older value.
SCORER_VERSION = "qalign_v1"


class ScorerError(RuntimeError):
    pass


@dataclass(frozen=True)
class Scores:
    aesthetics: float
    quality: float


class Scorer(Protocol):
    """What the service needs from a scorer. ``QAlignScorer`` is the real
    one; the tests inject a fake with the same shape."""

    model_id: str
    version: str

    def load(self) -> None: ...

    def unload(self) -> None: ...

    def score(self, image: Any) -> Scores: ...

    def vram_used_bytes(self) -> int | None: ...


def _clamp(value: float) -> float:
    return max(SCORE_MIN, min(SCORE_MAX, float(value)))


class QAlignScorer:
    """Holds ``q-future/one-align`` on the GPU between ``load`` and ``unload``.

    ``quantization`` is ``"8bit"`` (default; ~9 GB, no measurable loss on the
    model card's benchmarks), ``"4bit"`` (~5 GB, for a card that has to keep
    headroom) or ``"none"`` (fp16, ~16 GB, which does not fit the production
    card and exists for a bigger one).
    """

    def __init__(
        self,
        *,
        model_id: str = DEFAULT_MODEL_ID,
        cache_dir: Path | None = None,
        device: str = "cuda",
        quantization: str = "8bit",
    ) -> None:
        if quantization not in {"8bit", "4bit", "none"}:
            raise ScorerError(f"unknown quantization {quantization!r}")
        self.model_id = model_id
        self.version = SCORER_VERSION
        self.cache_dir = cache_dir
        self.device = device
        self.quantization = quantization
        self._model: Any = None

    # ── lifecycle ──────────────────────────────────────────────────────────

    def load(self) -> None:
        if self._model is not None:
            return
        import torch
        from transformers import AutoModelForCausalLM

        started = time.monotonic()
        kwargs: dict[str, Any] = {
            "trust_remote_code": True,
            "cache_dir": str(self.cache_dir) if self.cache_dir else None,
        }
        if self.device == "cuda":
            if not torch.cuda.is_available():
                raise ScorerError("AESTHETIC_DEVICE=cuda but no CUDA device is visible")
            kwargs["device_map"] = {"": 0}
            kwargs["torch_dtype"] = torch.float16
            if self.quantization != "none":
                from transformers import BitsAndBytesConfig

                kwargs["quantization_config"] = (
                    BitsAndBytesConfig(load_in_8bit=True)
                    if self.quantization == "8bit"
                    else BitsAndBytesConfig(
                        load_in_4bit=True,
                        bnb_4bit_compute_dtype=torch.float16,
                        bnb_4bit_quant_type="nf4",
                    )
                )
        else:
            # CPU is for a smoke run on a box without a card, not for the
            # nightly job: the model needs 20–60 s per photo there.
            kwargs["torch_dtype"] = torch.float32
        log.info(
            "loading %s (device=%s, quantization=%s)",
            self.model_id, self.device, self.quantization,
        )
        model = AutoModelForCausalLM.from_pretrained(self.model_id, **kwargs)
        if self.device != "cuda":
            model = model.to(self.device)
        model.eval()
        self._model = model
        log.info("loaded %s in %.1fs", self.model_id, time.monotonic() - started)

    def unload(self) -> None:
        if self._model is None:
            return
        self._model = None
        gc.collect()
        try:
            import torch

            if torch.cuda.is_available():
                torch.cuda.empty_cache()
                torch.cuda.ipc_collect()
        except Exception:  # pragma: no cover - torch missing or no CUDA
            pass
        log.info("unloaded %s", self.model_id)

    # ── inference ──────────────────────────────────────────────────────────

    def score(self, image: Any) -> Scores:
        if self._model is None:
            raise ScorerError("model not loaded")
        import torch

        with torch.inference_mode():
            aesthetics = self._model.score([image], task_="aesthetics", input_="image")
            quality = self._model.score([image], task_="quality", input_="image")
        return Scores(
            aesthetics=_clamp(_first(aesthetics)),
            quality=_clamp(_first(quality)),
        )

    def vram_used_bytes(self) -> int | None:
        try:
            import torch

            if torch.cuda.is_available():
                return int(torch.cuda.memory_allocated(0))
        except Exception:  # pragma: no cover
            pass
        return None


def _first(value: Any) -> float:
    """``model.score`` returns a tensor of one value per input image."""

    try:
        return float(value[0])
    except (TypeError, IndexError):
        return float(value)


def scorer_from_env() -> QAlignScorer:
    models_dir = Path(os.environ.get("MODELS_DIR", "/models"))
    return QAlignScorer(
        model_id=os.environ.get("AESTHETIC_MODEL_ID", DEFAULT_MODEL_ID),
        cache_dir=Path(os.environ.get("HF_HOME", str(models_dir / "hf-cache"))),
        device=os.environ.get("AESTHETIC_DEVICE", "cuda"),
        quantization=os.environ.get("AESTHETIC_QUANT", "8bit"),
    )

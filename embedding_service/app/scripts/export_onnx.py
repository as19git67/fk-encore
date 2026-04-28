"""Export the production CLIP + DINOv2 fp32 weights to ONNX, then quantise
each ONNX graph to INT8 with onnxruntime's dynamic-weight quantiser.

Outputs land in ${MODELS_DIR}/onnx/ and are picked up later by the
OnnxInt8Backend that the quantization_eval script will compare against
the torch reference. Three files come out:

    clip_image_int8.onnx  — OpenCLIP visual tower, ~1.3 GB (fp32 ~5 GB)
    clip_text_int8.onnx   — XLM-RoBERTa-Large text tower, ~0.6 GB
    dinov2_int8.onnx      — facebook/dinov2-base CLS extractor, ~0.08 GB

Idempotent: an existing non-empty target file means the step has run
before and is skipped. Set FORCE_REEXPORT=1 to redo from scratch.

Designed to be invoked via `optimize_models.sh`, which sets the env vars
this module reads (MODELS_DIR, CLIP_MODEL_NAME, etc.) and prints a tidy
header. Running it directly works too.
"""

from __future__ import annotations

import logging
import os
import sys
from pathlib import Path
from typing import Tuple

# Cap thread pools BEFORE torch / onnxruntime get imported. Both libraries
# read OMP_NUM_THREADS / MKL_NUM_THREADS at load time and otherwise default
# to logical-CPU count (16 on a 12600K), which fights the container's
# cpuset="0-11" and triggers pthread_setaffinity_np EINVAL noise from ORT.
# Match the service's EMBED_NUM_THREADS handling in app/main.py so
# everything below sees a consistent 6-thread pool on the production target.
def _default_thread_count() -> int:
    return max(1, (os.cpu_count() or 2) // 2)


_EMBED_THREADS = int(os.environ.get("EMBED_NUM_THREADS") or _default_thread_count())
os.environ.setdefault("OMP_NUM_THREADS", str(_EMBED_THREADS))
os.environ.setdefault("MKL_NUM_THREADS", str(_EMBED_THREADS))
os.environ.setdefault("OPENBLAS_NUM_THREADS", str(_EMBED_THREADS))

import torch
from torch import nn

logger = logging.getLogger("export_onnx")


# ---------------------------------------------------------------------------
# Paths and config
# ---------------------------------------------------------------------------

MODELS_DIR = Path(os.environ.get("MODELS_DIR", "/models"))
ONNX_DIR = MODELS_DIR / "onnx"

# Match the production model selection in app/config.py. We re-read here
# instead of importing settings to keep this script runnable with a stripped-
# down PYTHONPATH (e.g. inside `optimize_models.sh` before the service is up).
CLIP_MODEL_NAME = os.environ.get("CLIP_MODEL_NAME", "xlm-roberta-large-ViT-H-14")
CLIP_PRETRAINED = os.environ.get("CLIP_PRETRAINED", "frozen_laion5b_s13b_b90k")
DINO_MODEL_NAME = os.environ.get("DINO_MODEL_NAME", "facebook/dinov2-base")

FORCE = os.environ.get("FORCE_REEXPORT", "").lower() in ("1", "true", "yes")

# CLIP / DINOv2 vision input is 224x224 — the same shape the embedders
# produce after preprocessing. Keep the static dim here so the exported
# graph's spatial-positional embeddings line up; only the batch dimension
# is left dynamic.
IMAGE_SIZE = 224
# OpenCLIP H/14 text uses CLIP tokenizer with context length 77, but the
# multilingual XLM-RoBERTa variant uses 514 (RoBERTa max). We trace at
# the model's configured value rather than hard-coding so a swap to a
# different text encoder still works.
TEXT_CTX_FALLBACK = 77

# opset 17 is the lowest version where LayerNormalisation lands as a real
# ONNX op (no decomposition). H-14 has a lot of those, so the file size
# and runtime cost noticeably benefit.
OPSET = 17

# Force the legacy TorchScript-based exporter. The Dynamo-based exporter
# (torch>=2.5's default) is still maturing for large transformers like
# ViT-H-14 and pulls in onnxscript at trace time. Empirically the legacy
# path produces a more straightforward graph that onnxruntime's
# quantize_dynamic handles cleanly.
USE_DYNAMO_EXPORTER = False


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _need_export(target: Path) -> bool:
    """Skip if the file already exists and is non-empty (and FORCE is not set)."""
    if FORCE:
        return True
    if target.exists() and target.stat().st_size > 0:
        logger.info("skip %s — already present (%.1f MB)", target.name, target.stat().st_size / (1024 * 1024))
        return False
    return True


def _quantize_int8(fp32_path: Path, int8_path: Path) -> None:
    """Dynamic-weight INT8 quantisation via onnxruntime.

    Dynamic == only weights are quantised; activations stay fp32 and are
    cast at op boundaries. That avoids the calibration step a static
    quantiser would need, costs ~1% accuracy on most transformer workloads,
    and benefits massively from VNNI on Alder Lake (the production CPU).

    op_types_to_quantize is restricted to MatMul + Gemm because ORT-CPU-EP
    has no usable ConvInteger kernel for ViT-style patch-embedding Conv2d
    layers — the default quantiser converts them and InferenceSession then
    aborts with "Could not find an implementation for ConvInteger". MatMul
    + Gemm carry >95% of the FLOPs in CLIP / DINOv2 transformers anyway,
    so leaving the leading Conv (and any other unsupported op) in fp32
    barely costs any speedup.
    """
    from onnxruntime.quantization import quantize_dynamic, QuantType

    logger.info("quantising %s -> %s (INT8)", fp32_path.name, int8_path.name)
    quantize_dynamic(
        model_input=str(fp32_path),
        model_output=str(int8_path),
        weight_type=QuantType.QInt8,
        op_types_to_quantize=["MatMul", "Gemm"],
    )
    size_mb = int8_path.stat().st_size / (1024 * 1024)
    logger.info("  done: %.1f MB", size_mb)


def _check_onnx(path: Path) -> None:
    """Run the official onnx checker — catches malformed graphs early.

    Pass the path string instead of a loaded ModelProto: large models
    (CLIP H/14 is ~5 GB fp32) exceed protobuf's 2 GB hard limit on a
    single serialised message. onnx.load() builds the big ModelProto in
    RAM fine, but check_model(model) calls SerializeToString() under the
    hood which then fails with "Failed to serialize proto". The path
    overload streams the file and follows external-data references
    transparently, so it scales.
    """
    import onnx

    onnx.checker.check_model(str(path))


def _smoke_test(path: Path, dummy_inputs: dict) -> None:
    """Load with onnxruntime and run one forward pass to confirm shapes match.

    Pin the intra-op pool to _EMBED_THREADS so ORT doesn't fan out to
    cpuset-restricted cores and emit "pthread_setaffinity_np failed"
    warnings — those land at error-level in stdout and confuse a quick
    operator skim of the script's output.
    """
    import onnxruntime as ort

    opts = ort.SessionOptions()
    opts.intra_op_num_threads = _EMBED_THREADS
    opts.inter_op_num_threads = 1
    sess = ort.InferenceSession(str(path), opts, providers=["CPUExecutionProvider"])
    outputs = sess.run(None, dummy_inputs)
    shapes = [o.shape for o in outputs]
    logger.info("  smoke-test ok, output shapes: %s", shapes)


# ---------------------------------------------------------------------------
# CLIP visual tower
# ---------------------------------------------------------------------------


class ClipImageWrapper(nn.Module):
    """Expose only encode_image as forward — torch.onnx.export traces forward()."""

    def __init__(self, clip_model: nn.Module) -> None:
        super().__init__()
        self.clip = clip_model

    def forward(self, pixel_values: torch.Tensor) -> torch.Tensor:
        feats = self.clip.encode_image(pixel_values)
        # OpenCLIP returns un-normalised features; do the L2-normalise inside
        # the graph so downstream consumers don't have to remember to.
        return feats / feats.norm(dim=-1, keepdim=True).clamp(min=1e-12)


def export_clip_image() -> Tuple[Path, Path]:
    """Export OpenCLIP visual tower to fp32 ONNX, then INT8."""
    fp32 = ONNX_DIR / "clip_image.fp32.onnx"
    int8 = ONNX_DIR / "clip_image_int8.onnx"

    if not _need_export(int8):
        return fp32, int8

    import open_clip

    logger.info("loading OpenCLIP %s (%s) ...", CLIP_MODEL_NAME, CLIP_PRETRAINED)
    model, _, _ = open_clip.create_model_and_transforms(
        CLIP_MODEL_NAME, pretrained=CLIP_PRETRAINED
    )
    model = model.eval()

    wrapper = ClipImageWrapper(model)
    dummy = torch.randn(1, 3, IMAGE_SIZE, IMAGE_SIZE)

    if _need_export(fp32):
        logger.info("exporting CLIP image -> %s ...", fp32.name)
        with torch.inference_mode():
            torch.onnx.export(
                wrapper,
                (dummy,),
                str(fp32),
                input_names=["pixel_values"],
                output_names=["image_features"],
                dynamic_axes={
                    "pixel_values": {0: "batch"},
                    "image_features": {0: "batch"},
                },
                opset_version=OPSET,
                do_constant_folding=True,
                dynamo=USE_DYNAMO_EXPORTER,
            )
        _check_onnx(fp32)

    _quantize_int8(fp32, int8)
    _smoke_test(int8, {"pixel_values": dummy.numpy()})
    # Free the heavy fp32 graph from RAM before we move on to the text tower.
    del wrapper, model
    return fp32, int8


# ---------------------------------------------------------------------------
# CLIP text tower
# ---------------------------------------------------------------------------


class ClipTextWrapper(nn.Module):
    def __init__(self, clip_model: nn.Module) -> None:
        super().__init__()
        self.clip = clip_model

    def forward(self, input_ids: torch.Tensor) -> torch.Tensor:
        feats = self.clip.encode_text(input_ids)
        return feats / feats.norm(dim=-1, keepdim=True).clamp(min=1e-12)


def export_clip_text() -> Tuple[Path, Path]:
    fp32 = ONNX_DIR / "clip_text.fp32.onnx"
    int8 = ONNX_DIR / "clip_text_int8.onnx"

    if not _need_export(int8):
        return fp32, int8

    import open_clip

    logger.info("loading OpenCLIP %s (%s) for text export...", CLIP_MODEL_NAME, CLIP_PRETRAINED)
    model, _, _ = open_clip.create_model_and_transforms(
        CLIP_MODEL_NAME, pretrained=CLIP_PRETRAINED
    )
    model = model.eval()

    # OpenCLIP's tokenizer determines context_length; for HF-backed text
    # encoders (xlm-roberta-large) the model's own attribute holds it.
    ctx_len = getattr(model, "context_length", None) or TEXT_CTX_FALLBACK
    logger.info("  text context length: %d", ctx_len)

    wrapper = ClipTextWrapper(model)
    # Token IDs are int64; pad token id 1 is RoBERTa's default. Any consistent
    # padding works for tracing — actual values come from the tokenizer at run
    # time, what matters here is the dtype and shape.
    dummy = torch.ones(1, ctx_len, dtype=torch.long)

    if _need_export(fp32):
        logger.info("exporting CLIP text -> %s ...", fp32.name)
        with torch.inference_mode():
            torch.onnx.export(
                wrapper,
                (dummy,),
                str(fp32),
                input_names=["input_ids"],
                output_names=["text_features"],
                dynamic_axes={
                    "input_ids": {0: "batch"},
                    "text_features": {0: "batch"},
                },
                opset_version=OPSET,
                do_constant_folding=True,
                dynamo=USE_DYNAMO_EXPORTER,
            )
        _check_onnx(fp32)

    _quantize_int8(fp32, int8)
    _smoke_test(int8, {"input_ids": dummy.numpy()})
    del wrapper, model
    return fp32, int8


# ---------------------------------------------------------------------------
# DINOv2
# ---------------------------------------------------------------------------


class DinoCLSWrapper(nn.Module):
    """Feed pixels in, get the CLS token out — the only thing the embedder uses."""

    def __init__(self, dino: nn.Module) -> None:
        super().__init__()
        self.dino = dino

    def forward(self, pixel_values: torch.Tensor) -> torch.Tensor:
        out = self.dino(pixel_values=pixel_values)
        cls = out.last_hidden_state[:, 0, :]
        return cls / cls.norm(dim=-1, keepdim=True).clamp(min=1e-12)


def export_dinov2() -> Tuple[Path, Path]:
    fp32 = ONNX_DIR / "dinov2.fp32.onnx"
    int8 = ONNX_DIR / "dinov2_int8.onnx"

    if not _need_export(int8):
        return fp32, int8

    from transformers import AutoModel

    logger.info("loading %s ...", DINO_MODEL_NAME)
    model = AutoModel.from_pretrained(DINO_MODEL_NAME).eval()

    wrapper = DinoCLSWrapper(model)
    dummy = torch.randn(1, 3, IMAGE_SIZE, IMAGE_SIZE)

    if _need_export(fp32):
        logger.info("exporting DINOv2 -> %s ...", fp32.name)
        with torch.inference_mode():
            torch.onnx.export(
                wrapper,
                (dummy,),
                str(fp32),
                input_names=["pixel_values"],
                output_names=["cls_features"],
                dynamic_axes={
                    "pixel_values": {0: "batch"},
                    "cls_features": {0: "batch"},
                },
                opset_version=OPSET,
                do_constant_folding=True,
                dynamo=USE_DYNAMO_EXPORTER,
            )
        _check_onnx(fp32)

    _quantize_int8(fp32, int8)
    _smoke_test(int8, {"pixel_values": dummy.numpy()})
    del wrapper, model
    return fp32, int8


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------


def _disable_mha_fastpath() -> None:
    """Make nn.MultiheadAttention exportable.

    PyTorch's fast path for MHA dispatches into a fused C++ op
    `_native_multi_head_attention` for which the legacy ONNX exporter has
    no symbolic — opset 17 + nn.MultiheadAttention crashes with
    "Exporting the operator 'aten::_native_multi_head_attention' to ONNX
    opset version 17 is not supported". OpenCLIP's transformer blocks use
    nn.MultiheadAttention, so the visual + text towers are both affected.

    Toggling the global fastpath flag forces the slow path, which decomposes
    into standard ops (linear + softmax + bmm) that ONNX has no problem
    with. Cost: ~5-10% slower trace; we never run inference in the trace,
    so this is irrelevant.

    The flag exists from torch 2.0 onwards, but its location moved in 2.4
    (torch.backends.mha.set_fastpath_enabled); guard with hasattr for
    forward-compat.
    """
    backend = getattr(torch.backends, "mha", None)
    setter = getattr(backend, "set_fastpath_enabled", None) if backend else None
    if setter is None:
        logger.warning(
            "torch.backends.mha.set_fastpath_enabled not available — MHA export may fail"
        )
        return
    setter(False)
    logger.info("disabled MHA fastpath for ONNX-exportability")


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(levelname)-7s | %(message)s")
    ONNX_DIR.mkdir(parents=True, exist_ok=True)
    logger.info("ONNX_DIR=%s  FORCE=%s", ONNX_DIR, FORCE)
    _disable_mha_fastpath()

    # Sequential is intentional: each model is several GB in fp32 RAM during
    # export and the quantiser holds a second copy. Running them concurrently
    # would peak at ~12 GB+, which is tight on a 16 GB box where the rest of
    # the stack also needs memory.
    export_clip_image()
    export_clip_text()
    export_dinov2()

    logger.info("All ONNX/INT8 artefacts up to date in %s", ONNX_DIR)

    if not FORCE:
        # Surface a final inventory so the operator can sanity-check sizes.
        for p in sorted(ONNX_DIR.glob("*_int8.onnx")):
            logger.info("  %s  %.1f MB", p.name, p.stat().st_size / (1024 * 1024))

    return 0


if __name__ == "__main__":
    sys.exit(main())

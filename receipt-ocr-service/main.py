"""Fast receipt OCR service: image preprocessing + PaddleOCR + small LLM.

Pipeline per request (~3-7 s on CPU for the normal sharp-image path):
  1. Geometry correction and deskew, retaining the sharp colour scan
  2. Text recognition via PaddleOCR; enhanced variants only on weak results
  3. Structured field extraction via small LLM (Qwen2.5-3B-Instruct)
  4. JSON response: amount, date, store, currency, items, raw_text

Runs entirely on CPU. No GPU required.
"""

from __future__ import annotations

import asyncio
import base64
import functools
import json
import logging
import os
import re
import resource
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator, Callable, TypeVar

import cv2
import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field

from receipt_amount import (
    AmountDecision,
    VALUE_PATTERN,
    decide_layout_amount,
    decide_text_amount,
    looks_amount_related,
    parse_amount,
)
from receipt_semantics import resolve_receipt_date, validate_receipt_items

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
)
log = logging.getLogger("receipt-ocr")


# ─── Config ──────────────────────────────────────────────────────────────────

def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    return int(raw)


MODELS_DIR = Path(os.environ.get("MODELS_DIR") or "/models")
LLM_MODEL_PATH = Path(
    os.environ.get("LLM_MODEL_PATH")
    or str(MODELS_DIR / "qwen2.5-3b-instruct-q4_k_m.gguf")
)
LLM_CTX = _env_int("LLM_CTX", 4096)
LLM_THREADS = _env_int("LLM_THREADS", os.cpu_count() or 4)
LLM_GPU_LAYERS = _env_int("LLM_GPU_LAYERS", 0)

OCR_LANG = os.environ.get("OCR_LANG", "latin")
OCR_MAX_LONG_SIDE = _env_int("OCR_MAX_LONG_SIDE", 2000)
# Set to "0" to disable contour-based auto-crop + perspective correction.
OCR_AUTOCROP = os.environ.get("OCR_AUTOCROP", "1") == "1"
# Set to "0" to disable 90/180/270 orientation normalization. When on, the
# service runs a few quick low-resolution OCR probes per receipt to pick the
# most readable page rotation (handles receipts photographed sideways/upside
# down, which EXIF rotation can't catch).
OCR_ORIENT = os.environ.get("OCR_ORIENT", "1") == "1"
ORIENT_PROBE_LONG_SIDE = _env_int("ORIENT_PROBE_LONG_SIDE", 720)
# The winning rotation must beat upright by at least this factor, so near-ties
# default to no rotation rather than flip-flopping on noise.
ORIENT_MARGIN = float(os.environ.get("ORIENT_MARGIN", "1.15"))
# Set to "1" to disable the LLM step and use regex-only extraction
REGEX_ONLY = os.environ.get("REGEX_ONLY", "0") == "1"


# ─── Lifespan: load models once ─────────────────────────────────────────────

_state: dict[str, Any] = {"ocr": None, "llm": None}


def _rss_mb() -> float:
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    from paddleocr import PaddleOCR

    log.info("Loading PaddleOCR (lang=%s)", OCR_LANG)
    _state["ocr"] = PaddleOCR(
        use_angle_cls=True,
        lang=OCR_LANG,
        show_log=False,
        use_gpu=False,
    )
    log.info("PaddleOCR loaded (RSS=%.0f MB)", _rss_mb())

    if not REGEX_ONLY:
        if not LLM_MODEL_PATH.exists():
            log.info("LLM model not found at %s. Attempting download...", LLM_MODEL_PATH)
            import subprocess

            script_path = Path("/usr/local/bin/download_model.sh")
            if not script_path.exists():
                script_path = Path(__file__).parent / "download_model.sh"
            if script_path.exists():
                try:
                    subprocess.run([str(script_path)], check=True)
                except Exception as e:
                    log.error("Auto-download failed: %s", e)
                    raise RuntimeError(
                        f"LLM model not found at {LLM_MODEL_PATH} and auto-download failed."
                    ) from e
            else:
                raise RuntimeError(f"LLM model not found at {LLM_MODEL_PATH}")

        from llama_cpp import Llama

        log.info(
            "Loading Llama from %s (ctx=%d, threads=%d)",
            LLM_MODEL_PATH, LLM_CTX, LLM_THREADS,
        )
        _state["llm"] = Llama(
            model_path=str(LLM_MODEL_PATH),
            n_ctx=LLM_CTX,
            n_threads=LLM_THREADS,
            n_gpu_layers=LLM_GPU_LAYERS,
            verbose=False,
        )
        log.info("Llama loaded (RSS=%.0f MB)", _rss_mb())
    else:
        log.info("REGEX_ONLY=1 — LLM step disabled, using regex extraction")

    log.info("Ready.")
    yield


app = FastAPI(title="receipt-ocr-service", version="1.0.0", lifespan=lifespan)


# ─── Blocking-call offload ───────────────────────────────────────────────────

_inference_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="ocr-inference")
_inference_sem: asyncio.Semaphore | None = None


def _get_sem() -> asyncio.Semaphore:
    global _inference_sem
    if _inference_sem is None:
        _inference_sem = asyncio.Semaphore(1)
    return _inference_sem


_T = TypeVar("_T")


async def _run_blocking(
    func: Callable[..., _T],
    *args: Any,
    acquire_timeout: float = 30.0,
    **kwargs: Any,
) -> _T:
    sem = _get_sem()
    try:
        await asyncio.wait_for(sem.acquire(), timeout=acquire_timeout)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=503, detail="service busy")
    try:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(
            _inference_executor, functools.partial(func, *args, **kwargs)
        )
    finally:
        sem.release()


# ─── Image preprocessing ────────────────────────────────────────────────────

def _order_quad(pts: np.ndarray) -> np.ndarray:
    """Order four corner points as top-left, top-right, bottom-right, bottom-left."""
    rect = np.zeros((4, 2), dtype=np.float32)
    s = pts.sum(axis=1)
    rect[0] = pts[np.argmin(s)]   # top-left: smallest x+y
    rect[2] = pts[np.argmax(s)]   # bottom-right: largest x+y
    d = np.diff(pts, axis=1).ravel()
    rect[1] = pts[np.argmin(d)]   # top-right: smallest y-x
    rect[3] = pts[np.argmax(d)]   # bottom-left: largest y-x
    return rect


def _find_document_quad(gray: np.ndarray) -> np.ndarray | None:
    """Find the dominant rectangular region (receipt sitting on a contrasting
    background). Returns its 4 corners as a (4,2) float32 array, or None when no
    confident quadrilateral covering a meaningful share of the frame is found —
    in which case the caller keeps the full frame."""
    h, w = gray.shape[:2]
    img_area = float(h * w)
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(blurred, 50, 150)
    # Close small gaps so the receipt outline forms one continuous contour.
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (9, 9))
    closed = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, kernel)

    contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    for cnt in sorted(contours, key=cv2.contourArea, reverse=True)[:5]:
        area = cv2.contourArea(cnt)
        if area < 0.20 * img_area:
            # Largest remaining contour is too small to be the receipt — stop.
            break
        peri = cv2.arcLength(cnt, True)
        approx = cv2.approxPolyDP(cnt, 0.02 * peri, True)
        if len(approx) == 4 and cv2.isContourConvex(approx):
            return approx.reshape(4, 2).astype(np.float32)
    return None


def _four_point_warp(img: np.ndarray, quad: np.ndarray) -> np.ndarray:
    """Deskew + crop the image to the given quadrilateral via a perspective warp."""
    rect = _order_quad(quad)
    tl, tr, br, bl = rect
    max_w = int(max(np.linalg.norm(br - bl), np.linalg.norm(tr - tl)))
    max_h = int(max(np.linalg.norm(tr - br), np.linalg.norm(tl - bl)))
    if max_w < 10 or max_h < 10:
        return img
    dst = np.array(
        [[0, 0], [max_w - 1, 0], [max_w - 1, max_h - 1], [0, max_h - 1]],
        dtype=np.float32,
    )
    mat = cv2.getPerspectiveTransform(rect, dst)
    return cv2.warpPerspective(img, mat, (max_w, max_h))


def _rotate_90s(img: np.ndarray, angle: int) -> np.ndarray:
    """Lossless rotation by a multiple of 90 degrees (counter-clockwise)."""
    if angle == 90:
        return cv2.rotate(img, cv2.ROTATE_90_COUNTERCLOCKWISE)
    if angle == 180:
        return cv2.rotate(img, cv2.ROTATE_180)
    if angle == 270:
        return cv2.rotate(img, cv2.ROTATE_90_CLOCKWISE)
    return img


def _orientation_score(img_bgr: np.ndarray) -> float:
    """Score how 'readable' an image is via a fast, low-resolution OCR pass.
    Higher = more confident, more recognized characters. Returns 0.0 when the
    OCR model is unavailable (e.g. in unit tests), so callers leave the image
    untouched."""
    ocr = _state["ocr"]
    if ocr is None:
        return 0.0
    h, w = img_bgr.shape[:2]
    long_side = max(h, w)
    if long_side > ORIENT_PROBE_LONG_SIDE:
        s = ORIENT_PROBE_LONG_SIDE / long_side
        img_bgr = cv2.resize(img_bgr, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
    try:
        # cls=False: detection without per-line angle correction, so an
        # upside-down page scores low (which is exactly the signal we want).
        result = ocr.ocr(img_bgr, cls=False)
    except Exception:
        return 0.0
    if not result or not result[0]:
        return 0.0
    score = 0.0
    for _box, (text, conf) in result[0]:
        t = (text or "").strip()
        if conf >= 0.5 and len(t) >= 2:
            score += float(conf) * len(t)
    return score


def _detect_orientation(img_bgr: np.ndarray) -> int:
    """Pick the page rotation (0/90/180/270, counter-clockwise) that makes the
    receipt most readable, by scoring a quick low-res OCR pass at each. Returns
    0 when orientation handling is disabled, the OCR model is unavailable, or no
    rotation clearly beats upright."""
    if not OCR_ORIENT or _state["ocr"] is None:
        return 0
    scores = {angle: _orientation_score(_rotate_90s(img_bgr, angle)) for angle in (0, 90, 180, 270)}
    best = max(scores, key=lambda a: scores[a])
    if scores[best] <= 0:
        return 0
    if best != 0 and scores[best] < scores[0] * ORIENT_MARGIN:
        return 0
    return best


def correct_geometry(img_bytes: bytes) -> tuple[np.ndarray, bool]:
    """Decode, resize-cap, auto-crop + perspective-correct, and rotate upright.

    Returns (bgr_image, corrected) where `corrected` is True when a crop/warp or
    a non-zero rotation was applied. The result is a clean color image suitable
    for storage — no OCR-specific denoise/CLAHE is baked in."""
    arr = np.frombuffer(img_bytes, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("Could not decode image")

    h, w = img.shape[:2]
    max_side = max(h, w)
    if max_side > OCR_MAX_LONG_SIDE:
        scale = OCR_MAX_LONG_SIDE / max_side
        img = cv2.resize(img, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)

    corrected = False

    # Auto-crop + perspective-correct the receipt when it forms a detectable
    # quadrilateral on a contrasting background. No-op (full frame kept) when no
    # confident 4-corner contour is found, so a full-frame receipt is unaffected.
    if OCR_AUTOCROP:
        quad = _find_document_quad(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY))
        if quad is not None:
            img = _four_point_warp(img, quad)
            corrected = True

    # Normalize 90/180/270 misrotation (receipt photographed sideways or upside
    # down) so the stored image and the OCR input are both upright.
    rot = _detect_orientation(img)
    if rot != 0:
        img = _rotate_90s(img, rot)
        corrected = True

    return img, corrected


def _hough_line_coords(line: np.ndarray) -> tuple[int, int, int, int] | None:
    """Normalize HoughLinesP output across OpenCV 4 and 5.

    OpenCV 4 commonly returns each segment as ``(1, 4)`` while OpenCV 5 may
    return it directly as ``(4,)``. Flattening makes the deskew path independent
    of that binding detail.
    """
    coords = np.asarray(line).reshape(-1)
    if coords.size != 4:
        return None
    return int(coords[0]), int(coords[1]), int(coords[2]), int(coords[3])


def _prepare_storage_and_ocr_images(
    img: np.ndarray,
) -> tuple[np.ndarray, np.ndarray]:
    """Build aligned storage and OCR variants from a corrected camera image.

    The storage variant keeps the original colour pixels and fine print. The
    The secondary OCR variant increases local contrast for faint thermal print.
    Any small-angle deskew is applied identically to both variants so Paddle's
    text boxes can safely be used to crop the stored image. The sharp storage
    variant remains the primary OCR input; enhanced variants are fallbacks.
    """
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    # CLAHE fallback for faint thermal print and uneven lighting. Do not
    # denoise here: even moderate NLM can erase thin decimal points and glyph
    # strokes. A much milder denoised variant is built only when needed.
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    enhanced = clahe.apply(gray)

    # Deskew via Hough line detection
    edges = cv2.Canny(enhanced, 50, 150, apertureSize=3)
    lines = cv2.HoughLinesP(edges, 1, np.pi / 180, threshold=80, minLineLength=100, maxLineGap=10)
    median_angle = 0.0
    if lines is not None and len(lines) > 0:
        angles = []
        for line in lines:
            coords = _hough_line_coords(line)
            if coords is None:
                continue
            x1, y1, x2, y2 = coords
            angle = np.degrees(np.arctan2(y2 - y1, x2 - x1))
            if abs(angle) < 15:
                angles.append(angle)
        if angles:
            median_angle = float(np.median(angles))
    storage = img
    if abs(median_angle) > 0.3:
        h2, w2 = enhanced.shape[:2]
        center = (w2 // 2, h2 // 2)
        mat = cv2.getRotationMatrix2D(center, median_angle, 1.0)
        enhanced = cv2.warpAffine(
            enhanced, mat, (w2, h2),
            flags=cv2.INTER_CUBIC,
            borderMode=cv2.BORDER_REPLICATE,
        )
        storage = cv2.warpAffine(
            storage, mat, (w2, h2),
            flags=cv2.INTER_LANCZOS4,
            borderMode=cv2.BORDER_REPLICATE,
        )

    # Convert back to 3-channel for PaddleOCR
    return storage, cv2.cvtColor(enhanced, cv2.COLOR_GRAY2BGR)


def enhance_for_ocr(img: np.ndarray) -> np.ndarray:
    """Return only the OCR working copy for legacy callers and tests."""
    _storage, ocr = _prepare_storage_and_ocr_images(img)
    return ocr


def _mild_denoised_ocr_variant(img: np.ndarray) -> np.ndarray:
    """Build a conservative denoise fallback without touching stored pixels."""
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    denoised = cv2.fastNlMeansDenoising(
        gray,
        h=4,
        templateWindowSize=7,
        searchWindowSize=21,
    )
    clahe = cv2.createCLAHE(clipLimit=1.6, tileGridSize=(8, 8))
    return cv2.cvtColor(clahe.apply(denoised), cv2.COLOR_GRAY2BGR)


def _binary_ocr_variant(img: np.ndarray) -> np.ndarray:
    """Build an adaptive-threshold fallback for very faint or uneven paper."""
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    binary = cv2.adaptiveThreshold(
        gray,
        255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY,
        31,
        12,
    )
    return cv2.cvtColor(binary, cv2.COLOR_GRAY2BGR)


def preprocess_image(img_bytes: bytes) -> np.ndarray:
    """Decode + geometry-correct + OCR-enhance in one step. Convenience wrapper
    used by tests and any caller that only needs the OCR-ready image."""
    img, _ = correct_geometry(img_bytes)
    return enhance_for_ocr(img)


# ─── OCR ─────────────────────────────────────────────────────────────────────

def _format_visual_row(items: list[dict[str, Any]]) -> str:
    """Format one visual row while retaining large column gaps for the LLM."""
    ordered = sorted(items, key=lambda item: item["left"])
    parts: list[str] = []
    previous: dict[str, Any] | None = None
    for item in ordered:
        text = item["text"].strip()
        if not text:
            continue
        if previous is not None:
            gap = item["left"] - previous["right"]
            typical_height = max(1.0, min(item["height"], previous["height"]))
            if gap > 2.2 * typical_height:
                parts.append("|")
        parts.append(text)
        previous = item
    return " ".join(parts)


def _build_visual_rows(lines: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Rebuild receipt rows from Paddle's independently detected text boxes.

    Paddle commonly returns the product name, quantity and right-aligned price
    as separate boxes.  Treating every box as a newline destroys that spatial
    relationship before the parser sees it. Baselines are more stable than raw
    overlap when adjacent rows use different font sizes.
    """
    if not lines:
        return []

    normalized_lines: list[dict[str, Any]] = []
    for source in lines:
        line = dict(source)
        points = line.get("box", [])
        xs = [float(point[0]) for point in points]
        line.setdefault("left", min(xs) if xs else float(line["x"]))
        line.setdefault("right", max(xs) if xs else float(line["x"]))
        line.setdefault("height", max(1.0, line["bottom"] - line["top"]))
        normalized_lines.append(line)
    boxes = sorted(normalized_lines, key=lambda line: (line["top"], line["x"]))
    rows: list[dict[str, Any]] = []

    for line in boxes:
        height = max(1.0, line["bottom"] - line["top"])
        best_row: dict[str, Any] | None = None
        best_score = -1.0
        for row in rows:
            baseline_distance = abs(line["bottom"] - row["baseline"])
            same_baseline = baseline_distance <= 0.35 * max(height, row["height"])
            if same_baseline:
                score = 1.0 - baseline_distance / max(height, row["height"])
                if score > best_score:
                    best_row = row
                    best_score = score

        if best_row is None:
            rows.append({
                "lines": [line],
                "top": line["top"],
                "bottom": line["bottom"],
                "height": height,
                "y": line["y"],
                "baseline": line["bottom"],
            })
            continue

        best_row["lines"].append(line)
        best_row["top"] = min(best_row["top"], line["top"])
        best_row["bottom"] = max(best_row["bottom"], line["bottom"])
        best_row["height"] = max(1.0, best_row["bottom"] - best_row["top"])
        best_row["y"] = (
            sum(item["y"] for item in best_row["lines"])
            / len(best_row["lines"])
        )
        best_row["baseline"] = (
            sum(item["bottom"] for item in best_row["lines"])
            / len(best_row["lines"])
        )

    rows.sort(key=lambda row: row["y"])
    for row in rows:
        row["lines"].sort(key=lambda item: item["left"])
        row["text"] = _format_visual_row(row["lines"])
    return rows


def _reconstruct_visual_lines(lines: list[dict[str, Any]]) -> list[str]:
    """Compatibility wrapper used by existing tests and callers."""
    return [row["text"] for row in _build_visual_rows(lines)]


def run_ocr(
    img: np.ndarray,
) -> tuple[str, list[dict[str, Any]], list[dict[str, Any]]]:
    """Run PaddleOCR and return text, boxes and reconstructed visual rows."""
    ocr = _state["ocr"]
    result = ocr.ocr(img, cls=True)

    if not result or not result[0]:
        return "", [], []

    lines: list[dict[str, Any]] = []
    for line_info in result[0]:
        box, (text, confidence) = line_info
        xs = [point[0] for point in box]
        ys = [point[1] for point in box]
        y_center = (min(ys) + max(ys)) / 2
        x_center = (min(xs) + max(xs)) / 2
        lines.append({
            "text": text,
            "confidence": float(confidence),
            "y": float(y_center),
            "x": float(x_center),
            "top": float(min(ys)),
            "bottom": float(max(ys)),
            "left": float(min(xs)),
            "right": float(max(xs)),
            "height": float(max(ys) - min(ys)),
            "box": box,
        })

    # Preserve the boxes for confidence/debugging, but give all downstream
    # parsers text reconstructed as visual receipt rows.
    lines.sort(key=lambda l: (l["y"], l["x"]))
    rows = _build_visual_rows(lines)
    full_text = "\n".join(row["text"] for row in rows)
    return full_text, lines, rows


def _ocr_quality(
    text: str,
    lines: list[dict[str, Any]],
) -> tuple[float, int, int]:
    """Score an OCR result without favouring a tiny high-confidence fragment.

    Paddle confidence is weighted by recognised non-whitespace characters and
    discounted when text/line coverage is implausibly small for a receipt.
    """
    usable = [
        line for line in lines
        if line.get("text", "").strip() and line.get("confidence", 0.0) > 0
    ]
    char_count = sum(
        len(re.sub(r"\s+", "", str(line["text"])))
        for line in usable
    )
    if char_count == 0:
        return 0.0, 0, 0
    weighted_confidence = sum(
        float(line["confidence"])
        * len(re.sub(r"\s+", "", str(line["text"])))
        for line in usable
    ) / char_count
    text_chars = len(re.sub(r"\s+", "", text))
    coverage = min(1.0, max(char_count, text_chars) / 120.0)
    line_coverage = min(1.0, len(usable) / 8.0)
    score = weighted_confidence * (0.65 + 0.20 * coverage + 0.15 * line_coverage)
    return float(score), char_count, len(usable)


def _run_ocr_with_fallbacks(
    storage_img: np.ndarray,
    contrast_img: np.ndarray,
) -> tuple[str, list[dict[str, Any]], list[dict[str, Any]], np.ndarray]:
    """Run sharp-first PaddleOCR and retry only when recognition is weak.

    The unfiltered colour scan is always primary. Contrast enhancement, mild
    denoising and adaptive thresholding are tried progressively; the best
    Paddle result wins. Strong results stop the chain early for performance.
    """
    variants: list[tuple[str, Callable[[], np.ndarray]]] = [
        ("sharp", lambda: storage_img),
        ("contrast", lambda: contrast_img),
        ("mild-denoise", lambda: _mild_denoised_ocr_variant(storage_img)),
        ("binary", lambda: _binary_ocr_variant(storage_img)),
    ]
    best_result: tuple[
        str,
        list[dict[str, Any]],
        list[dict[str, Any]],
        np.ndarray,
    ] = (
        "",
        [],
        [],
        storage_img,
    )
    best_score = -1.0
    best_name = "sharp"

    for name, build_variant in variants:
        variant = build_variant()
        result = run_ocr(variant)
        score, chars, line_count = _ocr_quality(result[0], result[1])
        if score > best_score:
            best_result = (*result, variant)
            best_score = score
            best_name = name
        if score >= 0.82 and chars >= 60 and line_count >= 5:
            break

    log.info("PaddleOCR variant=%s quality=%.3f", best_name, max(0.0, best_score))
    return best_result


def _crop_to_ocr_content(
    img: np.ndarray,
    lines: list[dict[str, Any]],
) -> np.ndarray:
    """Crop large undetected borders using Paddle's recognised text region.

    This is a conservative fallback for receipts whose paper edge cannot be
    represented by a reliable quadrilateral (for example white paper on a
    light table or a receipt touching the frame). A generous eight-percent
    margin preserves logos and paper around the recognised text.
    """
    usable = [
        line for line in lines
        if line.get("text", "").strip() and line.get("confidence", 0.0) >= 0.45
    ]
    if len(usable) < 2:
        return img

    h, w = img.shape[:2]
    xs = [float(point[0]) for line in usable for point in line["box"]]
    ys = [float(point[1]) for line in usable for point in line["box"]]
    pad_x = max(24, round(w * 0.08))
    pad_y = max(32, round(h * 0.08))
    left = max(0, int(min(xs)) - pad_x)
    right = min(w, int(max(xs)) + pad_x)
    top = max(0, int(min(ys)) - pad_y)
    bottom = min(h, int(max(ys)) + pad_y)

    # Avoid tiny, visually irrelevant crops and malformed OCR bounds.
    if right <= left or bottom <= top:
        return img
    removed_area = 1.0 - ((right - left) * (bottom - top)) / float(w * h)
    if removed_area < 0.08:
        return img
    return img[top:bottom, left:right]


def _focused_amount_ocr(
    img: np.ndarray,
    rows: list[dict[str, Any]],
) -> AmountDecision:
    """Retry only the likely totals/payment region with two image variants.

    This intentionally runs only when the first layout decision is uncertain,
    keeping the normal fast path unchanged. A scaled grayscale pass helps tiny
    totals; adaptive thresholding helps faint thermal print.
    """
    h, w = img.shape[:2]
    related = [row for row in rows if looks_amount_related(str(row.get("text", "")))]
    if related:
        typical_height = float(np.median([row["height"] for row in related]))
        top = max(0, int(min(row["top"] for row in related) - 2.5 * typical_height))
        bottom = min(h, int(max(row["bottom"] for row in related) + 3.5 * typical_height))
    else:
        # Totals normally sit in the upper two thirds, before tax/footer text.
        top, bottom = 0, max(1, int(h * 0.68))
    if bottom - top < 20:
        return AmountDecision(None, 0.0, "focused:invalid-region")

    region = img[top:bottom, 0:w]
    scaled = cv2.resize(region, None, fx=2.0, fy=2.0, interpolation=cv2.INTER_CUBIC)
    gray = cv2.cvtColor(scaled, cv2.COLOR_BGR2GRAY)
    binary = cv2.adaptiveThreshold(
        gray,
        255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY,
        31,
        12,
    )
    variants = [scaled, cv2.cvtColor(binary, cv2.COLOR_GRAY2BGR)]
    best = AmountDecision(None, 0.0, "focused:unresolved")
    for variant in variants:
        try:
            _text, _lines, focused_rows = run_ocr(variant)
        except Exception as exc:
            log.warning("Focused amount OCR failed: %s", exc)
            continue
        decision = decide_layout_amount(focused_rows)
        if decision.amount is not None and decision.confidence > best.confidence:
            best = AmountDecision(
                decision.amount,
                max(0.0, decision.confidence - 0.02),
                f"focused:{decision.source}",
            )
            if best.confidence >= 0.95:
                break
    return best


def _serialize_layout_rows(
    rows: list[dict[str, Any]],
    image_width: int,
) -> list[dict[str, Any]]:
    """Return compact normalized geometry safe to pass to item extraction."""
    width = max(1, image_width)
    return [
        {
            "text": row["text"],
            "cells": [
                {
                    "text": cell["text"],
                    "x": round(cell["left"] / width, 4),
                    "width": round((cell["right"] - cell["left"]) / width, 4),
                    "confidence": round(cell["confidence"], 3),
                }
                for cell in row["lines"]
                if cell["text"].strip()
            ],
        }
        for row in rows
        if row["text"].strip()
    ]


# ─── Regex extraction (fallback / REGEX_ONLY mode) ──────────────────────────

_VALUE_PATTERN = VALUE_PATTERN

def _parse_german_amount(raw: str) -> float | None:
    return parse_amount(raw)


def _extract_labeled_total(text: str, *, strong_only: bool = False) -> float | None:
    """Return a deterministically labelled receipt total.

    Strong business labels are safe enough to override an LLM guess.
    """
    decision = decide_text_amount(text)
    if decision.amount is not None and (
        not strong_only or decision.source.startswith(("label:", "validated:"))
    ):
        return decision.amount
    return None


def regex_extract(text: str) -> dict[str, Any]:
    """Best-effort field extraction using regex patterns."""
    amount = _extract_labeled_total(text)

    if amount is None:
        all_amounts = [
            _parse_german_amount(m.group(1))
            for m in re.finditer(_VALUE_PATTERN, text)
            if m.group(1)
        ]
        valid = [a for a in all_amounts if a is not None and a > 0]
        if valid:
            amount = valid[-1]

    date = resolve_receipt_date(text, None)

    return {"amount": amount, "date": date, "store": None, "currency": "EUR", "items": []}


# ─── LLM structured extraction ──────────────────────────────────────────────

# Two prompts so the save-critical core fields (amount/date/store) can be
# returned synchronously with a small token budget, while the much longer
# line-item list is generated by a separate, asynchronous call.
_EXTRACT_CORE_SYSTEM = """Du bist ein präziser Kassenbon-Parser. Extrahiere die Kernfelder
aus dem OCR-Text eines Kassenbons.

Antworte ausschließlich mit gültigem JSON (UTF-8, ohne Markdown-Fences):
{
  "amount": <Gesamtbetrag als Zahl (z.B. 12.99) oder null>,
  "date": <Datum als "YYYY-MM-DD" oder null>,
  "store": <Geschäftsname / Filiale oder null>,
  "currency": <dreistelliger Währungscode, Standard "EUR">
}

Regeln:
- amount: Immer den GESAMTBETRAG (Summe/Total/Zu zahlen), nicht Einzelposten.
  Deutsche Beträge: Komma = Dezimaltrenner (12,99 → 12.99), Punkt = Tausender (1.234,56 → 1234.56).
  OCR-Artefakte: "«", "€" und "e" können alle das Euro-Zeichen darstellen.
  WICHTIG: Wenn Kassenbon sowohl "Zwischensumme" als auch "Summe" enthält:
    - "Zwischensumme" = Betrag VOR Rabatten/Coupons → NICHT als amount verwenden
    - "Summe" = tatsächlicher Endbetrag NACH allen Abzügen → als amount verwenden
  Coupon-Ersparnis, Rabatte und Aktionen reduzieren die finale Summe.
  Zahlungszeilen wie "Bar", "Gegeben", "EC-Cash", "Kartenzahlung", "VISA"
  oder "Mastercard" sind NICHT der Gesamtbetrag. Insbesondere ist der Betrag
  hinter "Bar" häufig das gegebene Bargeld vor Abzug des Rückgelds.
- date: Das Kaufdatum, nicht Druckdatum oder MHD. Bei mehrdeutigen numerischen
  Daten (z.B. 05/07/2026) das Format NICHT raten: Sprache, Land, Adresse und
  Währung des Belegs beachten. Deutsche Belege verwenden Tag/Monat/Jahr.
- store: Der Geschäftsname aus dem Kopfbereich (z.B. "REWE", "ALDI", "dm", "Rossmann").
- Halluziniere keine Daten. Bei Unsicherheit: null."""


_EXTRACT_ITEMS_SYSTEM = """Du bist ein präziser Kassenbon-Parser. Extrahiere die Einzelposten
aus dem OCR-Text eines Kassenbons.

Antworte ausschließlich mit gültigem JSON (UTF-8, ohne Markdown-Fences):
{
  "items": [{"name": "Artikelname", "amount": 1.99}, ...]
}

Regeln:
- items: Nur erkennbare Einzelposten mit Preis. NICHT den Gesamtbetrag,
  Zwischensummen, Rückgeld, Pfand-Summen oder Steuerzeilen.
- Deutsche Beträge: Komma = Dezimaltrenner (1,99 → 1.99).
  OCR-Artefakte: "«", "€" und "e" können alle das Euro-Zeichen darstellen.

Deutsches Kassenbon-Format (typisch):
  [Menge×] [EAN/Barcode] Artikelname [Einzelpreis] [Gesamtpreis] [MwSt-Kz]
- Das Zeichen "|" markiert eine große horizontale Lücke bzw. Spaltengrenze
  aus dem Beleglayout. Text und rechts davon stehender Preis gehören weiterhin
  zur selben visuellen Belegzeile.
- Lange Ziffernfolgen (8–13 Stellen, EAN/GTIN) vor dem Artikelnamen = Barcode, NICHT Produktname — ignorieren
- Mengenkennzeichen am Zeilenanfang: "2x", "2 x", "2 ×" — OCR kann "x" als "%" lesen (z.B. "2%")
- Bei Mehrfachmengen: die Zeile hat Einzelpreis UND Gesamtpreis → nutze den Gesamtpreis (letzter Preis) als amount
- MwSt-Kennzeichen am Zeilenende (A, B, 1, 2 o.ä.) sind keine Preise — ignorieren
- Zutaten, Extras, Beilagen und Modifikatoren unterhalb eines Hauptartikels
  sind KEINE eigenen Posten, wenn in ihrer eigenen visuellen Zeile kein Preis steht.
  Den Preis des Hauptartikels niemals auf nachfolgende unbepreiste Zeilen übertragen.

Werbetexte und Aktionen ignorieren:
- Werbebanner, Coupon-Aktionen, Prospekthinweise und Rabattangebote am Belegende sind KEINE Artikel
- Erkennbar durch: "% auf …", Datumsangaben künftiger Aktionen, App-Hinweise, QR-Code-Texte

- Leere Liste wenn unklar. Halluziniere keine Posten."""


_MOJIBAKE = re.compile(r"[ÂÃ][\x80-\xBF]")


def _repair_mojibake(value: str | None) -> str | None:
    if not value or not _MOJIBAKE.search(value):
        return value
    try:
        return value.encode("latin-1").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return value


def _llm_json(system: str, text: str, max_tokens: int) -> dict[str, Any] | None:
    """Run one constrained JSON completion. Returns the parsed object, or None
    when the LLM is unavailable, errors, or returns non-JSON."""
    llm = _state["llm"]
    if llm is None:
        return None
    user_prompt = f"Kassenbon OCR-Text:\n---\n{text[:3000]}\n---"
    try:
        completion = llm.create_chat_completion(
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user_prompt},
            ],
            response_format={"type": "json_object"},
            temperature=0.1,
            max_tokens=max_tokens,
        )
    except Exception as exc:
        log.warning("LLM call failed: %s", exc)
        return None
    raw = completion["choices"][0]["message"]["content"].strip()
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        log.warning("LLM returned non-JSON: %r", raw[:200])
        return None


def llm_extract_core(text: str, reference_date: str | None = None) -> dict[str, Any]:
    """Extract the save-critical fields (amount, date, store, currency) with a
    small token budget so the synchronous response stays fast. Line items are
    fetched separately via llm_extract_items. Falls back to regex when the LLM
    is unavailable."""
    data = _llm_json(_EXTRACT_CORE_SYSTEM, text, max_tokens=128)
    if data is None:
        r = regex_extract(text)
        r["date"] = resolve_receipt_date(text, r.get("date"), reference_date)
        return {k: r[k] for k in ("amount", "date", "store", "currency")}

    for key in ("store", "currency"):
        if isinstance(data.get(key), str):
            data[key] = _repair_mojibake(data[key])

    amount = data.get("amount")
    if isinstance(amount, str):
        amount = _parse_german_amount(amount)
    if not isinstance(amount, (int, float)) or amount <= 0:
        amount = None
    else:
        amount = round(float(amount), 2)

    # OCR noise around payment rows can make the LLM prefer cash tendered or
    # change. An explicit total label is more reliable and wins deterministically.
    labeled_total = _extract_labeled_total(text, strong_only=True)
    if labeled_total is not None:
        amount = round(labeled_total, 2)

    model_date = data.get("date") if isinstance(data.get("date"), str) else None
    date_val = resolve_receipt_date(text, model_date, reference_date)

    store = data.get("store")
    store = store.strip() if isinstance(store, str) and store.strip() else None

    currency = data.get("currency", "EUR")
    if not isinstance(currency, str) or len(currency) != 3:
        currency = "EUR"

    return {"amount": amount, "date": date_val, "store": store, "currency": currency.upper()}


def _layout_text_for_items(
    text: str,
    layout_rows: list[dict[str, Any]] | None,
) -> str:
    if not layout_rows:
        return text
    formatted: list[str] = []
    for row in layout_rows:
        cells = row.get("cells", []) if isinstance(row, dict) else []
        if not isinstance(cells, list):
            continue
        parts = []
        for cell in cells:
            if not isinstance(cell, dict) or not str(cell.get("text", "")).strip():
                continue
            x = cell.get("x")
            position = f"@{float(x):.2f}" if isinstance(x, (int, float)) else "@?"
            parts.append(f"{position} {str(cell['text']).strip()}")
        if parts:
            formatted.append(" | ".join(parts))
    if not formatted:
        return text
    return "Layout-Zeilen (Position 0=links, 1=rechts):\n" + "\n".join(formatted)


def llm_extract_items(
    text: str,
    layout_rows: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """Extract line items from OCR text. Heavier (larger token budget) — meant
    to be called asynchronously, after the core fields have been returned.
    Returns an empty list in regex-only mode or when the LLM is unavailable."""
    if REGEX_ONLY:
        return []
    data = _llm_json(
        _EXTRACT_ITEMS_SYSTEM,
        _layout_text_for_items(text, layout_rows),
        max_tokens=512,
    )
    if data is None:
        return []

    items: list[dict[str, Any]] = []
    raw_items = data.get("items", [])
    if isinstance(raw_items, list):
        for item in raw_items:
            if not isinstance(item, dict):
                continue
            name = item.get("name", "")
            item_amount = item.get("amount")
            if isinstance(item_amount, str):
                item_amount = _parse_german_amount(item_amount)
            if isinstance(name, str) and name.strip() and isinstance(item_amount, (int, float)):
                items.append({
                    "name": _repair_mojibake(name.strip()),
                    "amount": round(float(item_amount), 2),
                })
    return validate_receipt_items(text, layout_rows, items, _parse_german_amount)


# ─── API endpoints ──────────────────────────────────────────────────────────

class ReceiptResult(BaseModel):
    amount: float | None = None
    date: str | None = None
    store: str | None = None
    currency: str = "EUR"
    items: list[dict[str, Any]] = Field(default_factory=list)
    raw_text: str = ""
    ocr_confidence: float = 0.0
    amount_confidence: float = 0.0
    amount_source: str | None = None
    layout_rows: list[dict[str, Any]] = Field(default_factory=list)
    processing_ms: int = 0
    # Base64 JPEG of the display-ready receipt scan: cropped, perspective-
    # corrected, upright and deskewed, while retaining the colour source pixels
    # and fine print. OCR-only denoising/contrast is never persisted.
    corrected_image: str | None = None


def _encode_processed_jpeg(img: np.ndarray) -> str | None:
    """Encode the display-ready receipt image for persistent PDF storage."""
    ok, buf = cv2.imencode(".jpg", img, [int(cv2.IMWRITE_JPEG_QUALITY), 95])
    if not ok:
        return None
    return base64.b64encode(buf.tobytes()).decode("ascii")


@app.post("/extract", response_model=ReceiptResult)
async def extract_receipt(
    file: UploadFile = File(...),
    reference_date: str | None = Form(None),
) -> ReceiptResult:
    t0 = time.monotonic()
    img_bytes = await file.read()
    if len(img_bytes) == 0:
        raise HTTPException(status_code=400, detail="empty file")
    if len(img_bytes) > 20 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="file too large (max 20 MB)")

    def _pipeline(data: bytes) -> dict[str, Any]:
        storage_img, _geometry_corrected = correct_geometry(data)
        storage_img, ocr_img = _prepare_storage_and_ocr_images(storage_img)
        full_text, lines, rows, selected_ocr_img = _run_ocr_with_fallbacks(
            storage_img,
            ocr_img,
        )
        # Contour detection is deliberately strict. If it cannot see all four
        # paper edges, use Paddle's text geometry to remove the remaining large
        # camera background before persisting the final PDF.
        stored_scan = _crop_to_ocr_content(storage_img, lines)
        processed_image = _encode_processed_jpeg(stored_scan)

        if not full_text.strip():
            return {
                "amount": None, "date": None, "store": None,
                "currency": "EUR", "items": [], "raw_text": "",
                "ocr_confidence": 0.0,
                "amount_confidence": 0.0,
                "amount_source": None,
                "layout_rows": [],
                "corrected_image": processed_image,
            }

        avg_confidence = (
            sum(l["confidence"] for l in lines) / len(lines)
            if lines else 0.0
        )

        if REGEX_ONLY or _state["llm"] is None:
            r = regex_extract(full_text)
            core = {k: r[k] for k in ("amount", "date", "store", "currency")}
            core["date"] = resolve_receipt_date(full_text, core.get("date"), reference_date)
        else:
            core = llm_extract_core(full_text, reference_date)

        amount_decision = decide_layout_amount(rows)
        if amount_decision.confidence < 0.90:
            focused_decision = _focused_amount_ocr(selected_ocr_img, rows)
            if focused_decision.confidence > amount_decision.confidence:
                amount_decision = focused_decision

        llm_amount = core.get("amount")
        if amount_decision.amount is None and isinstance(llm_amount, (int, float)):
            amount_decision = AmountDecision(round(float(llm_amount), 2), 0.55, "llm")
        if amount_decision.amount is not None:
            core["amount"] = amount_decision.amount

        out: dict[str, Any] = {
            **core, "items": [], "raw_text": full_text,
            "ocr_confidence": round(avg_confidence, 3),
            "amount_confidence": round(amount_decision.confidence, 3),
            "amount_source": amount_decision.source,
            "layout_rows": _serialize_layout_rows(rows, ocr_img.shape[1]),
            "corrected_image": processed_image,
        }

        # Line items are intentionally NOT extracted here: they dominate the LLM
        # generation time. The caller fetches them asynchronously via
        # /extract/items so the save-critical core fields return fast.
        return out

    result = await _run_blocking(_pipeline, img_bytes)
    elapsed_ms = int((time.monotonic() - t0) * 1000)
    result["processing_ms"] = elapsed_ms
    log.info(
        "Extracted receipt core: amount=%s source=%s amount_confidence=%.2f "
        "ocr_confidence=%.2f date=%s store=%s time=%dms",
        result.get("amount"), result.get("amount_source"),
        result.get("amount_confidence", 0),
        result.get("ocr_confidence", 0), result.get("date"), result.get("store"),
        elapsed_ms,
    )
    return ReceiptResult(**result)


class ItemsRequest(BaseModel):
    text: str = ""
    layout_rows: list[dict[str, Any]] = Field(default_factory=list)


class ItemsResult(BaseModel):
    items: list[dict[str, Any]] = Field(default_factory=list)
    processing_ms: int = 0


@app.post("/extract/items", response_model=ItemsResult)
async def extract_items(req: ItemsRequest) -> ItemsResult:
    """Second-stage extraction: line items from already-OCR'd text. Kept
    separate from /extract so the heavy item generation runs asynchronously
    without delaying the core fields the user needs to save a transaction."""
    t0 = time.monotonic()
    text = (req.text or "").strip()
    if not text:
        return ItemsResult(items=[], processing_ms=0)
    items = await _run_blocking(llm_extract_items, text, req.layout_rows)
    elapsed_ms = int((time.monotonic() - t0) * 1000)
    log.info("Extracted %d line items in %dms", len(items), elapsed_ms)
    return ItemsResult(items=items, processing_ms=elapsed_ms)


# ─── Meter reading OCR (Etappe 4) ─────────────────────────────────────────

# Pattern for plausible meter counter digits: an integer or decimal number
# with at least 3 digits before the decimal point (meters rarely show fewer).
# Accepts comma or period as decimal separator, optional thousands separator.
_METER_DIGIT_PATTERN = re.compile(
    r"(?<!\d)"                     # not preceded by a digit
    r"(\d[\d.]*\d)"                # core digit group (at least 2 digits, may contain dots)
    r"(?:[,.](\d{1,3}))?"         # optional decimal part after comma/period
    r"(?!\d)"                      # not followed by a digit
)


def _extract_meter_value(text: str, decimals: int = 0) -> tuple[float | None, float]:
    """Find the most likely meter counter value from OCR text.

    Heuristic: find all plausible multi-digit numbers, prefer the longest
    (meter counters show more digits than surrounding text like dates or
    serial numbers). Returns (value, confidence).
    """
    candidates: list[tuple[float, int, float]] = []
    for m in _METER_DIGIT_PATTERN.finditer(text):
        integer_part = m.group(1).replace(".", "")  # strip thousands separators
        decimal_part = m.group(2) or ""

        # Skip numbers that look like dates (DD.MM.YYYY patterns)
        full_match = m.group(0)
        if re.match(r"^\d{1,2}[.,]\d{1,2}[.,]\d{2,4}$", full_match):
            continue
        # Skip very short numbers (< 3 integer digits) — unlikely to be a meter
        if len(integer_part) < 3:
            continue

        try:
            if decimal_part:
                val = float(f"{integer_part}.{decimal_part}")
            else:
                val = float(integer_part)
        except ValueError:
            continue

        # Confidence: longer numbers are more likely the meter counter
        digit_count = len(integer_part) + len(decimal_part)
        conf = min(0.95, 0.5 + 0.07 * digit_count)
        candidates.append((val, digit_count, conf))

    if not candidates:
        return None, 0.0

    # Pick the candidate with the most digits (most likely the counter)
    candidates.sort(key=lambda c: c[1], reverse=True)
    return candidates[0][0], candidates[0][2]


class MeterReadingResult(BaseModel):
    value: float | None = None
    confidence: float = 0.0
    raw_text: str = ""
    processing_ms: int = 0
    corrected_image: str | None = None


@app.post("/meter-reading", response_model=MeterReadingResult)
async def extract_meter_reading(
    file: UploadFile = File(...),
    decimals: int = Form(0),
) -> MeterReadingResult:
    """Extract a meter counter value from a photo of a utility meter.

    Uses PaddleOCR to read digits, then a heuristic to pick the most
    plausible counter value (longest digit sequence). No LLM needed —
    meter displays show large, clear digits.
    """
    t0 = time.monotonic()
    img_bytes = await file.read()
    if len(img_bytes) == 0:
        raise HTTPException(status_code=400, detail="empty file")
    if len(img_bytes) > 20 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="file too large (max 20 MB)")

    def _pipeline(data: bytes) -> dict[str, Any]:
        storage_img, _corrected = correct_geometry(data)
        storage_img, ocr_img = _prepare_storage_and_ocr_images(storage_img)
        full_text, lines, rows, _ocr_img = _run_ocr_with_fallbacks(
            storage_img, ocr_img,
        )
        stored_scan = _crop_to_ocr_content(storage_img, lines)
        processed_image = _encode_processed_jpeg(stored_scan)

        value, confidence = _extract_meter_value(full_text, decimals)

        return {
            "value": value,
            "confidence": round(confidence, 3),
            "raw_text": full_text,
            "corrected_image": processed_image,
        }

    result = await _run_blocking(_pipeline, img_bytes)
    elapsed_ms = int((time.monotonic() - t0) * 1000)
    result["processing_ms"] = elapsed_ms
    log.info(
        "Meter reading OCR: value=%s confidence=%.2f time=%dms",
        result.get("value"), result.get("confidence", 0), elapsed_ms,
    )
    return MeterReadingResult(**result)


class PageOcrLine(BaseModel):
    text: str
    confidence: float
    left: float
    top: float
    right: float
    bottom: float


class PageOcrResult(BaseModel):
    lines: list[PageOcrLine] = Field(default_factory=list)
    full_text: str = ""
    mean_confidence: float = 0.0
    processing_ms: int = 0


@app.post("/ocr/page", response_model=PageOcrResult)
async def ocr_page(file: UploadFile = File(...)) -> PageOcrResult:
    """Recognise a *document page* image and return line boxes with confidence.

    Deliberately not /extract. That endpoint is receipt-shaped: it corrects
    perspective on a photographed till roll, crops to the receipt, retries with
    enhanced variants and then runs an LLM over the result. A document page
    arriving here has already been rasterised from a PDF at a known DPI and
    deskewed/contrast-cleaned by the caller (documents/ocr-preprocess.ts), so
    all of that would at best waste time and at worst warp a page that was
    already flat.

    What the caller wants is exactly one thing: PaddleOCR's own reading of the
    page, with the geometry and per-line confidence, so it can be compared
    against Tesseract's reading of the same pixels. Any preprocessing done here
    would make the two engines disagree about the *image* rather than about the
    text, which is the one thing that would make the comparison worthless.
    """

    t0 = time.monotonic()
    img_bytes = await file.read()
    if len(img_bytes) == 0:
        raise HTTPException(status_code=400, detail="empty file")
    if len(img_bytes) > 20 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="file too large (max 20 MB)")

    def _pipeline(data: bytes) -> dict[str, Any]:
        buf = np.frombuffer(data, dtype=np.uint8)
        img = cv2.imdecode(buf, cv2.IMREAD_COLOR)
        if img is None:
            raise HTTPException(status_code=400, detail="undecodable image")

        full_text, lines, _rows = run_ocr(img)
        out = [
            {
                "text": line["text"],
                "confidence": round(float(line["confidence"]), 4),
                "left": round(float(line["left"]), 1),
                "top": round(float(line["top"]), 1),
                "right": round(float(line["right"]), 1),
                "bottom": round(float(line["bottom"]), 1),
            }
            for line in lines
            if str(line.get("text", "")).strip()
        ]
        # Character-weighted, like _ocr_quality: a long line read badly should
        # weigh more than a two-character line read perfectly.
        chars = sum(len(re.sub(r"\s+", "", entry["text"])) for entry in out)
        mean = (
            sum(
                entry["confidence"] * len(re.sub(r"\s+", "", entry["text"]))
                for entry in out
            )
            / chars
            if chars
            else 0.0
        )
        return {"lines": out, "full_text": full_text, "mean_confidence": round(mean, 4)}

    result = await _run_blocking(_pipeline, img_bytes)
    result["processing_ms"] = int((time.monotonic() - t0) * 1000)
    log.info(
        "Page OCR: %d line(s) mean_conf=%.3f time=%dms",
        len(result["lines"]), result["mean_confidence"], result["processing_ms"],
    )
    return PageOcrResult(**result)


@app.get("/healthz")
async def healthz() -> dict[str, Any]:
    return {
        "status": "ok" if _state["ocr"] else "starting",
        "ocr_loaded": _state["ocr"] is not None,
        "llm_loaded": _state["llm"] is not None,
        "regex_only": REGEX_ONLY,
        "rss_mb": round(_rss_mb(), 1),
    }

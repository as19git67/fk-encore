"""Fast receipt OCR service: image preprocessing + PaddleOCR + small LLM.

Pipeline per request (~3-7 s on CPU):
  1. Image preprocessing (OpenCV: resize, grayscale, denoise, deskew)
  2. Text detection + recognition via PaddleOCR (PP-OCRv4, Latin)
  3. Structured field extraction via small LLM (Qwen2.5-3B-Instruct)
  4. JSON response: amount, date, store, currency, items, raw_text

Runs entirely on CPU. No GPU required.
"""

from __future__ import annotations

import asyncio
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
from fastapi import FastAPI, File, HTTPException, UploadFile
from pydantic import BaseModel, Field

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


def preprocess_image(img_bytes: bytes) -> np.ndarray:
    """Decode, resize, denoise, and prepare receipt image for OCR."""
    arr = np.frombuffer(img_bytes, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("Could not decode image")

    h, w = img.shape[:2]
    max_side = max(h, w)
    if max_side > OCR_MAX_LONG_SIDE:
        scale = OCR_MAX_LONG_SIDE / max_side
        img = cv2.resize(img, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)

    # Auto-crop + perspective-correct the receipt when it forms a detectable
    # quadrilateral on a contrasting background. No-op (full frame kept) when no
    # confident 4-corner contour is found, so a full-frame receipt is unaffected.
    if OCR_AUTOCROP:
        quad = _find_document_quad(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY))
        if quad is not None:
            img = _four_point_warp(img, quad)

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    # Adaptive denoising for thermal paper receipts
    denoised = cv2.fastNlMeansDenoising(gray, h=10, templateWindowSize=7, searchWindowSize=21)

    # CLAHE for contrast enhancement (handles uneven lighting)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    enhanced = clahe.apply(denoised)

    # Deskew via Hough line detection
    edges = cv2.Canny(enhanced, 50, 150, apertureSize=3)
    lines = cv2.HoughLinesP(edges, 1, np.pi / 180, threshold=80, minLineLength=100, maxLineGap=10)
    if lines is not None and len(lines) > 0:
        angles = []
        for line in lines:
            x1, y1, x2, y2 = line[0]
            angle = np.degrees(np.arctan2(y2 - y1, x2 - x1))
            if abs(angle) < 15:
                angles.append(angle)
        if angles:
            median_angle = float(np.median(angles))
            if abs(median_angle) > 0.3:
                h2, w2 = enhanced.shape[:2]
                center = (w2 // 2, h2 // 2)
                mat = cv2.getRotationMatrix2D(center, median_angle, 1.0)
                enhanced = cv2.warpAffine(
                    enhanced, mat, (w2, h2),
                    flags=cv2.INTER_CUBIC,
                    borderMode=cv2.BORDER_REPLICATE,
                )

    # Convert back to 3-channel for PaddleOCR
    return cv2.cvtColor(enhanced, cv2.COLOR_GRAY2BGR)


# ─── OCR ─────────────────────────────────────────────────────────────────────

def run_ocr(img: np.ndarray) -> tuple[str, list[dict[str, Any]]]:
    """Run PaddleOCR and return (full_text, structured_lines)."""
    ocr = _state["ocr"]
    result = ocr.ocr(img, cls=True)

    if not result or not result[0]:
        return "", []

    lines: list[dict[str, Any]] = []
    for line_info in result[0]:
        box, (text, confidence) = line_info
        y_center = (box[0][1] + box[2][1]) / 2
        x_center = (box[0][0] + box[2][0]) / 2
        lines.append({
            "text": text,
            "confidence": float(confidence),
            "y": float(y_center),
            "x": float(x_center),
            "box": box,
        })

    # Sort by vertical position (top to bottom), then left to right
    lines.sort(key=lambda l: (l["y"], l["x"]))

    full_text = "\n".join(l["text"] for l in lines)
    return full_text, lines


# ─── Regex extraction (fallback / REGEX_ONLY mode) ──────────────────────────

_VALUE_PATTERN = r"(\d{1,3}(?:[. ]\d{3})*(?:,\d{2})|\d+(?:[.,]\d{2}))"

_TOTAL_LABELS = re.compile(
    r"(?<![a-zA-ZäöüÄÖÜ])"
    r"(?:gesamt(?:betrag|summe)?|summe|total|zu\s*zahlen|betrag|endsumme|"
    r"karten(?:zahlung)?|ec[- ]?cash|bar|maestro|visa|mastercard|"
    r"girocard|v\s*pay|eur\b)"
    r"\D{0,40}" + _VALUE_PATTERN,
    re.IGNORECASE,
)

_DATE_PATTERN = re.compile(r"(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{2,4})")


def _parse_german_amount(raw: str) -> float | None:
    normalized = re.sub(r"[. ](?=\d{3}(?:\D|$))", "", raw).replace(",", ".")
    try:
        n = float(normalized)
        return n if n > 0 else None
    except ValueError:
        return None


def regex_extract(text: str) -> dict[str, Any]:
    """Best-effort field extraction using regex patterns."""
    amount: float | None = None
    match = _TOTAL_LABELS.search(text)
    if match and match.group(1):
        amount = _parse_german_amount(match.group(1))

    if amount is None:
        all_amounts = [
            _parse_german_amount(m.group(1))
            for m in re.finditer(_VALUE_PATTERN, text)
            if m.group(1)
        ]
        valid = [a for a in all_amounts if a is not None and a > 0]
        if valid:
            amount = valid[-1]

    date: str | None = None
    import datetime
    now = datetime.datetime.now()
    best_dist = float("inf")
    for m in _DATE_PATTERN.finditer(text):
        day, month, year = int(m.group(1)), int(m.group(2)), int(m.group(3))
        if year < 100:
            year += 2000
        if not (1 <= month <= 12 and 1 <= day <= 31 and 2010 <= year <= now.year + 1):
            continue
        try:
            d = datetime.date(year, month, day)
        except ValueError:
            continue
        dist = abs((now.date() - d).days)
        if dist < best_dist:
            best_dist = dist
            date = d.isoformat()

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
- date: Das Kaufdatum, nicht Druckdatum oder MHD.
- store: Der Geschäftsname aus dem Kopfbereich (z.B. "REWE", "ALDI", "dm").
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


def llm_extract_core(text: str) -> dict[str, Any]:
    """Extract the save-critical fields (amount, date, store, currency) with a
    small token budget so the synchronous response stays fast. Line items are
    fetched separately via llm_extract_items. Falls back to regex when the LLM
    is unavailable."""
    data = _llm_json(_EXTRACT_CORE_SYSTEM, text, max_tokens=128)
    if data is None:
        r = regex_extract(text)
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

    date_val = data.get("date")
    if not (isinstance(date_val, str) and re.match(r"^\d{4}-\d{2}-\d{2}$", date_val)):
        date_val = None

    store = data.get("store")
    store = store.strip() if isinstance(store, str) and store.strip() else None

    currency = data.get("currency", "EUR")
    if not isinstance(currency, str) or len(currency) != 3:
        currency = "EUR"

    return {"amount": amount, "date": date_val, "store": store, "currency": currency.upper()}


def llm_extract_items(text: str) -> list[dict[str, Any]]:
    """Extract line items from OCR text. Heavier (larger token budget) — meant
    to be called asynchronously, after the core fields have been returned.
    Returns an empty list in regex-only mode or when the LLM is unavailable."""
    if REGEX_ONLY:
        return []
    data = _llm_json(_EXTRACT_ITEMS_SYSTEM, text, max_tokens=512)
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
    return items


# ─── API endpoints ──────────────────────────────────────────────────────────

class ReceiptResult(BaseModel):
    amount: float | None = None
    date: str | None = None
    store: str | None = None
    currency: str = "EUR"
    items: list[dict[str, Any]] = Field(default_factory=list)
    raw_text: str = ""
    ocr_confidence: float = 0.0
    processing_ms: int = 0


@app.post("/extract", response_model=ReceiptResult)
async def extract_receipt(file: UploadFile = File(...)) -> ReceiptResult:
    t0 = time.monotonic()
    img_bytes = await file.read()
    if len(img_bytes) == 0:
        raise HTTPException(status_code=400, detail="empty file")
    if len(img_bytes) > 20 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="file too large (max 20 MB)")

    def _pipeline(data: bytes) -> dict[str, Any]:
        img = preprocess_image(data)
        full_text, lines = run_ocr(img)

        if not full_text.strip():
            return {
                "amount": None, "date": None, "store": None,
                "currency": "EUR", "items": [], "raw_text": "",
                "ocr_confidence": 0.0,
            }

        avg_confidence = (
            sum(l["confidence"] for l in lines) / len(lines)
            if lines else 0.0
        )

        if REGEX_ONLY or _state["llm"] is None:
            r = regex_extract(full_text)
            core = {k: r[k] for k in ("amount", "date", "store", "currency")}
        else:
            core = llm_extract_core(full_text)

        # Line items are intentionally NOT extracted here: they dominate the LLM
        # generation time. The caller fetches them asynchronously via
        # /extract/items so the save-critical core fields return fast.
        return {**core, "items": [], "raw_text": full_text, "ocr_confidence": round(avg_confidence, 3)}

    result = await _run_blocking(_pipeline, img_bytes)
    elapsed_ms = int((time.monotonic() - t0) * 1000)
    result["processing_ms"] = elapsed_ms
    log.info(
        "Extracted receipt core: amount=%s date=%s store=%s confidence=%.2f time=%dms",
        result.get("amount"), result.get("date"), result.get("store"),
        result.get("ocr_confidence", 0), elapsed_ms,
    )
    return ReceiptResult(**result)


class ItemsRequest(BaseModel):
    text: str = ""


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
    items = await _run_blocking(llm_extract_items, text)
    elapsed_ms = int((time.monotonic() - t0) * 1000)
    log.info("Extracted %d line items in %dms", len(items), elapsed_ms)
    return ItemsResult(items=items, processing_ms=elapsed_ms)


@app.get("/healthz")
async def healthz() -> dict[str, Any]:
    return {
        "status": "ok" if _state["ocr"] else "starting",
        "ocr_loaded": _state["ocr"] is not None,
        "llm_loaded": _state["llm"] is not None,
        "regex_only": REGEX_ONLY,
        "rss_mb": round(_rss_mb(), 1),
    }

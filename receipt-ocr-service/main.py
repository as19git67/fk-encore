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


def enhance_for_ocr(img: np.ndarray) -> np.ndarray:
    """OCR-specific enhancement of a geometry-corrected image: grayscale,
    denoise, CLAHE and small-angle Hough deskew. Returns a 3-channel image for
    PaddleOCR."""
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


def preprocess_image(img_bytes: bytes) -> np.ndarray:
    """Decode + geometry-correct + OCR-enhance in one step. Convenience wrapper
    used by tests and any caller that only needs the OCR-ready image."""
    img, _ = correct_geometry(img_bytes)
    return enhance_for_ocr(img)


# ─── OCR ─────────────────────────────────────────────────────────────────────

def _reconstruct_visual_lines(lines: list[dict[str, Any]]) -> list[str]:
    """Rebuild receipt rows from Paddle's independently detected text boxes.

    Paddle commonly returns the product name, quantity and right-aligned price
    as separate boxes.  Treating every box as a newline destroys that spatial
    relationship before the line-item parser sees it.  Boxes with substantial
    vertical overlap (or an almost identical baseline) belong to one visual
    row and are joined from left to right.
    """
    if not lines:
        return []

    boxes = sorted(lines, key=lambda line: (line["top"], line["x"]))
    rows: list[dict[str, Any]] = []

    for line in boxes:
        height = max(1.0, line["bottom"] - line["top"])
        best_row: dict[str, Any] | None = None
        best_score = -1.0
        for row in rows:
            overlap = max(
                0.0,
                min(line["bottom"], row["bottom"]) - max(line["top"], row["top"]),
            )
            overlap_ratio = overlap / min(height, row["height"])
            center_distance = abs(line["y"] - row["y"])
            same_baseline = center_distance <= 0.35 * max(height, row["height"])
            if overlap_ratio >= 0.45 or same_baseline:
                score = overlap_ratio - center_distance / max(height, row["height"])
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

    rows.sort(key=lambda row: row["y"])
    return [
        " ".join(
            item["text"].strip()
            for item in sorted(row["lines"], key=lambda item: item["x"])
            if item["text"].strip()
        )
        for row in rows
    ]


def run_ocr(img: np.ndarray) -> tuple[str, list[dict[str, Any]]]:
    """Run PaddleOCR and return (full_text, structured_lines)."""
    ocr = _state["ocr"]
    result = ocr.ocr(img, cls=True)

    if not result or not result[0]:
        return "", []

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
            "box": box,
        })

    # Preserve the boxes for confidence/debugging, but give all downstream
    # parsers text reconstructed as visual receipt rows.
    lines.sort(key=lambda l: (l["y"], l["x"]))
    full_text = "\n".join(_reconstruct_visual_lines(lines))
    return full_text, lines


# ─── Regex extraction (fallback / REGEX_ONLY mode) ──────────────────────────

_VALUE_PATTERN = r"(\d{1,3}(?:[. ]\d{3})*(?:,\d{2})|\d+(?:[.,]\d{2}))"

_TOTAL_LABELS = re.compile(
    r"(?<![a-zA-ZäöüÄÖÜ])"
    r"(?:gesamt(?:betrag|summe)?|summe|total|zu\s*zahlen|betrag|endsumme|eur\b)"
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
  OCR-Artefakte: "«", "€" und "e" können alle das Euro-Zeichen darstellen.
  WICHTIG: Wenn Kassenbon sowohl "Zwischensumme" als auch "Summe" enthält:
    - "Zwischensumme" = Betrag VOR Rabatten/Coupons → NICHT als amount verwenden
    - "Summe" = tatsächlicher Endbetrag NACH allen Abzügen → als amount verwenden
  Coupon-Ersparnis, Rabatte und Aktionen reduzieren die finale Summe.
  Zahlungszeilen wie "Bar", "Gegeben", "EC-Cash", "Kartenzahlung", "VISA"
  oder "Mastercard" sind NICHT der Gesamtbetrag. Insbesondere ist der Betrag
  hinter "Bar" häufig das gegebene Bargeld vor Abzug des Rückgelds.
- date: Das Kaufdatum, nicht Druckdatum oder MHD.
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
- Lange Ziffernfolgen (8–13 Stellen, EAN/GTIN) vor dem Artikelnamen = Barcode, NICHT Produktname — ignorieren
- Mengenkennzeichen am Zeilenanfang: "2x", "2 x", "2 ×" — OCR kann "x" als "%" lesen (z.B. "2%")
- Bei Mehrfachmengen: die Zeile hat Einzelpreis UND Gesamtpreis → nutze den Gesamtpreis (letzter Preis) als amount
- MwSt-Kennzeichen am Zeilenende (A, B, 1, 2 o.ä.) sind keine Preise — ignorieren

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
    # Base64 JPEG of the fully prepared receipt scan: cropped, perspective-
    # corrected, upright, deskewed, denoised and contrast-enhanced. The backend
    # always uses it to replace the camera image in the stored PDF.
    corrected_image: str | None = None


def _encode_processed_jpeg(img: np.ndarray) -> str | None:
    """Encode the display/OCR-ready receipt image for persistent PDF storage."""
    ok, buf = cv2.imencode(".jpg", img, [int(cv2.IMWRITE_JPEG_QUALITY), 92])
    if not ok:
        return None
    return base64.b64encode(buf.tobytes()).decode("ascii")


@app.post("/extract", response_model=ReceiptResult)
async def extract_receipt(file: UploadFile = File(...)) -> ReceiptResult:
    t0 = time.monotonic()
    img_bytes = await file.read()
    if len(img_bytes) == 0:
        raise HTTPException(status_code=400, detail="empty file")
    if len(img_bytes) > 20 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="file too large (max 20 MB)")

    def _pipeline(data: bytes) -> dict[str, Any]:
        storage_img, _geometry_corrected = correct_geometry(data)
        ocr_img = enhance_for_ocr(storage_img)
        processed_image = _encode_processed_jpeg(ocr_img)
        full_text, lines = run_ocr(ocr_img)

        if not full_text.strip():
            return {
                "amount": None, "date": None, "store": None,
                "currency": "EUR", "items": [], "raw_text": "",
                "ocr_confidence": 0.0,
                "corrected_image": processed_image,
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

        out: dict[str, Any] = {
            **core, "items": [], "raw_text": full_text,
            "ocr_confidence": round(avg_confidence, 3),
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

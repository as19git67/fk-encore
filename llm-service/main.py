"""FastAPI service fronting a local Llama (GGUF) classifier and a
sentence-transformers embedder.

The process expects both models to exist on disk *before* startup — see
``download_model.sh``. Model files live in a bind-mounted volume, not in the
image. Startup behaviour:

* ``Llama`` mmap's the GGUF file from disk (no network).
* ``SentenceTransformer`` loads the embedder from ``SENTENCE_TRANSFORMERS_HOME``
  (also no network, provided ``download_model.sh`` ran at least once).

The two exposed endpoints are :http:post:`/classify` (structured JSON output)
and :http:post:`/embed`, plus :http:get:`/healthz` for compose.
"""

from __future__ import annotations

import json
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
)
log = logging.getLogger("llm-service")


# ─── Config ────────────────────────────────────────────────────────────────────

MODELS_DIR = Path(os.environ.get("MODELS_DIR", "/models"))
LLM_MODEL_PATH = Path(os.environ.get("LLM_MODEL_PATH", str(MODELS_DIR / "llama.gguf")))
LLM_CTX = int(os.environ.get("LLM_CTX", "8192"))
LLM_THREADS = int(os.environ.get("LLM_THREADS", str(os.cpu_count() or 4)))
LLM_GPU_LAYERS = int(os.environ.get("LLM_GPU_LAYERS", "0"))

EMBEDDING_MODEL = os.environ.get("EMBEDDING_MODEL", "intfloat/multilingual-e5-base")
# sentence-transformers respects this env var as its on-disk cache location.
os.environ.setdefault("SENTENCE_TRANSFORMERS_HOME", str(MODELS_DIR / "st-cache"))
os.environ.setdefault("HF_HOME", str(MODELS_DIR / "hf-cache"))


# ─── Lifespan: load models once at startup ─────────────────────────────────────

_state: dict[str, Any] = {"llm": None, "embedder": None}


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    if not LLM_MODEL_PATH.exists():
        raise RuntimeError(
            f"LLM model not found at {LLM_MODEL_PATH}. "
            "Run download_model.sh to populate the models volume."
        )

    # Lazy imports keep `python main.py --help`-style inspection cheap and
    # move the heavy native-library load into startup, after logging is set up.
    from llama_cpp import Llama
    from sentence_transformers import SentenceTransformer

    log.info("Loading Llama from %s (ctx=%d, threads=%d, gpu_layers=%d)",
             LLM_MODEL_PATH, LLM_CTX, LLM_THREADS, LLM_GPU_LAYERS)
    _state["llm"] = Llama(
        model_path=str(LLM_MODEL_PATH),
        n_ctx=LLM_CTX,
        n_threads=LLM_THREADS,
        n_gpu_layers=LLM_GPU_LAYERS,
        verbose=False,
    )

    log.info("Loading embedder %s", EMBEDDING_MODEL)
    _state["embedder"] = SentenceTransformer(EMBEDDING_MODEL)

    log.info("Ready.")
    yield
    # Nothing to clean up — process exit releases the mmaps.


app = FastAPI(title="llm-service", version="1.0.0", lifespan=lifespan)


# ─── /healthz ──────────────────────────────────────────────────────────────────


@app.get("/healthz")
async def healthz() -> dict[str, Any]:
    return {
        "status": "ok" if _state["llm"] and _state["embedder"] else "starting",
        "llm_loaded": _state["llm"] is not None,
        "embedder_loaded": _state["embedder"] is not None,
        "llm_model_path": str(LLM_MODEL_PATH),
        "embedding_model": EMBEDDING_MODEL,
    }


# ─── /embed ────────────────────────────────────────────────────────────────────


class EmbedRequest(BaseModel):
    texts: list[str] = Field(..., min_length=1)


class EmbedResponse(BaseModel):
    embeddings: list[list[float]]
    dim: int


@app.post("/embed", response_model=EmbedResponse)
async def embed(req: EmbedRequest) -> EmbedResponse:
    embedder = _state["embedder"]
    if embedder is None:
        raise HTTPException(status_code=503, detail="embedder not loaded")
    vectors = embedder.encode(req.texts, normalize_embeddings=True).tolist()
    return EmbedResponse(embeddings=vectors, dim=len(vectors[0]) if vectors else 0)


# ─── /classify ─────────────────────────────────────────────────────────────────


class TaxonomyNode(BaseModel):
    slug: str
    name: str
    parent_slug: str | None = None


class TaxSectionEntry(BaseModel):
    """One German income-tax section (Anlage / Abzugsbereich) sent to the
    classifier so it can pick from a fixed label set, identical in spirit to
    :class:`TaxonomyNode` but flat (no parent) and with an extra human hint.
    """

    slug: str
    name: str
    group: str  # "einkuenfte" | "abzuege" | "bescheid" | "rahmen"
    hint: str | None = None


class ClassifyRequest(BaseModel):
    text: str = Field(..., min_length=1)
    taxonomy: list[TaxonomyNode] = Field(..., min_length=1)
    # Optional: if non-empty the classifier is asked to additionally decide
    # whether the document is relevant for the German income-tax return and
    # which section(s) it belongs to. Empty list = tax detection disabled.
    tax_sections: list[TaxSectionEntry] = Field(default_factory=list)
    # Optional hints: sender hint from OCR, upload filename, user locale.
    locale: str = "de"
    max_tags: int = 6


class TaxAssignment(BaseModel):
    """One (slug, confidence) tuple returned by the classifier for a
    tax-return section it thinks the document belongs to."""

    slug: str
    confidence: float = Field(..., ge=0.0, le=1.0)


class ClassifyResponse(BaseModel):
    category_slug: str
    title: str
    doc_date: str | None = None
    sender: str | None = None
    summary: str
    tags: list[str]
    confidence: float = Field(..., ge=0.0, le=1.0)
    # Tax-return fields — default "not relevant" so existing callers that
    # don't send ``tax_sections`` still get a valid response.
    tax_relevant: bool = False
    tax_year: int | None = Field(default=None, ge=2000, le=2100)
    tax_year_confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    tax_sections: list[TaxAssignment] = Field(default_factory=list)


_SYSTEM_PROMPT = """Du bist ein präziser Klassifikator für private Haushalts-Dokumente.
Antworte ausschließlich mit gültigem JSON (UTF-8, ohne Markdown-Fences) gemäß dem
vorgegebenen Schema.

Felder:
- category_slug: der am besten passende Slug aus der gegebenen Taxonomie.
  Wenn kein Zweig passt, verwende "sonstiges" und gib eine niedrige confidence.
- title: kurzer, sprechender Dokumenttitel (max. 80 Zeichen).
- doc_date: das auf dem Dokument gedruckte Datum als ISO-8601 YYYY-MM-DD,
  oder null falls nicht erkennbar.
- sender: Name des Absenders/Ausstellers (Firma, Behörde, Person), oder null.
- summary: 1-2 Sätze, deutsch, nüchtern — "Worum geht es?".
- tags: bis zu max_tags kurze, kleingeschriebene Stichwörter (keine Sätze).
- confidence: dein Vertrauen in die Kategorisierung, 0..1.

Halluziniere keine Daten, Beträge oder Absender. Bei Unsicherheit: null bzw.
niedrige confidence."""


_TAX_SYSTEM_PROMPT = """

STEUER-ERKENNUNG (nur wenn dir unten eine Liste von Steuer-Sektionen gezeigt wird)
Beurteile zusätzlich, ob das Dokument als Beleg für die deutsche
Einkommensteuererklärung dient.

Zusätzliche Felder:
- tax_relevant (bool): true, wenn das Dokument üblicherweise als Beleg,
  Bescheinigung oder Bescheid für die Einkommensteuererklärung dient
  (Lohnsteuerbescheinigung, Jahressteuerbescheinigung der Bank, Spenden-
  quittung, Handwerker-/Haushaltshilfe-Rechnung mit Kontobeleg, Krankheits-
  kosten, Vermietungsbelege, Kinderbetreuung, Steuerbescheid, …). false bei
  rein privaten Belegen ohne Steuerbezug (Supermarktkassenbon, Werbung,
  privater Schriftverkehr).
- tax_year (int | null): vierstelliges Kalenderjahr, für das der Beleg
  steuerlich zählt. Bei Jahresbescheinigungen ("Jahressteuerbescheinigung
  2024"): das genannte Jahr. Bei Einzelrechnungen: das Jahr des Leistungs-
  bzw. Zahlungsdatums (Zuflussprinzip). Bei Unsicherheit: null.
- tax_year_confidence (0..1): Vertrauen in das Steuerjahr.
- tax_sections: Liste der passenden Sektions-Slugs aus der unten gegebenen
  Liste, jeweils mit eigener confidence. Ein Beleg darf mehreren Sektionen
  zugeordnet werden (z.B. Handwerkerrechnung für das vermietete Objekt →
  sowohl werbungskosten-v als auch ggf. haushaltsnahe, falls Eigennutzungs-
  anteil). Leere Liste = keine passende Sektion / nicht steuerrelevant.
  Format: [{"slug": "anlage-n", "confidence": 0.91}, ...]. Verwende nur
  Slugs aus der Liste; erfinde keine neuen.
"""


def _taxonomy_outline(nodes: list[TaxonomyNode]) -> str:
    by_parent: dict[str | None, list[TaxonomyNode]] = {}
    for n in nodes:
        by_parent.setdefault(n.parent_slug, []).append(n)

    def render(parent: str | None, depth: int) -> list[str]:
        lines: list[str] = []
        for n in by_parent.get(parent, []):
            indent = "  " * depth
            lines.append(f"{indent}- {n.slug}: {n.name}")
            lines.extend(render(n.slug, depth + 1))
        return lines

    return "\n".join(render(None, 0))


_TAX_GROUP_LABELS: dict[str, str] = {
    "einkuenfte": "Einkünfte",
    "abzuege": "Abzüge",
    "bescheid": "Bescheide",
    "rahmen": "Rahmen / Stammdaten",
}
_TAX_GROUP_ORDER: tuple[str, ...] = ("einkuenfte", "abzuege", "bescheid", "rahmen")


def _tax_sections_outline(entries: list[TaxSectionEntry]) -> str:
    """Render the tax-section list grouped by ``group`` in a stable order.
    Empty input yields an empty string (caller must gate on that)."""

    if not entries:
        return ""

    by_group: dict[str, list[TaxSectionEntry]] = {}
    for e in entries:
        by_group.setdefault(e.group, []).append(e)

    lines: list[str] = []
    seen: set[str] = set()
    for group in _TAX_GROUP_ORDER:
        if group not in by_group:
            continue
        seen.add(group)
        lines.append(f"[{_TAX_GROUP_LABELS[group]}]")
        for e in by_group[group]:
            hint = f" — {e.hint}" if e.hint else ""
            lines.append(f"- {e.slug}: {e.name}{hint}")
    # Render any unexpected groups at the end so we never silently drop entries.
    for group, items in by_group.items():
        if group in seen:
            continue
        lines.append(f"[{group}]")
        for e in items:
            hint = f" — {e.hint}" if e.hint else ""
            lines.append(f"- {e.slug}: {e.name}{hint}")
    return "\n".join(lines)


@app.post("/classify", response_model=ClassifyResponse)
async def classify(req: ClassifyRequest) -> ClassifyResponse:
    llm = _state["llm"]
    if llm is None:
        raise HTTPException(status_code=503, detail="llm not loaded")

    # Cap the document text so prompt + response stay within n_ctx on a 3B model.
    # ~6000 chars ≈ 1500–2000 tokens, leaves plenty of room for the system prompt,
    # the taxonomy and the response.
    text = req.text[:6000]

    tax_active = bool(req.tax_sections)
    system_prompt = _SYSTEM_PROMPT + (_TAX_SYSTEM_PROMPT if tax_active else "")

    tax_block = (
        f"\n\nSteuer-Sektionen (slug: Name — Hinweis):\n{_tax_sections_outline(req.tax_sections)}"
        if tax_active
        else ""
    )

    user_prompt = (
        f"Taxonomie (slug: Name):\n{_taxonomy_outline(req.taxonomy)}{tax_block}\n\n"
        f"Max. Tags: {req.max_tags}\n\n"
        f"Dokumenttext:\n---\n{text}\n---"
    )

    try:
        completion = llm.create_chat_completion(
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            response_format={"type": "json_object"},
            temperature=0.2,
            # 768 tokens leaves headroom for the extra tax fields (up to a
            # handful of tax_sections entries) without touching n_ctx.
            max_tokens=768,
        )
    except Exception as exc:  # llama.cpp raises a generic Exception family
        log.exception("llm.create_chat_completion failed")
        raise HTTPException(status_code=500, detail=f"llm failure: {exc}") from exc

    raw = completion["choices"][0]["message"]["content"].strip()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        log.warning("LLM returned non-JSON payload: %r", raw[:200])
        raise HTTPException(status_code=502, detail=f"llm returned invalid JSON: {exc}") from exc

    # If tax detection is off, ignore any tax_* fields the LLM might have
    # hallucinated — they're not validated against a slug whitelist here.
    if not tax_active:
        for k in ("tax_relevant", "tax_year", "tax_year_confidence", "tax_sections"):
            data.pop(k, None)
    else:
        # Drop tax_sections entries whose slug is not in the provided list —
        # the LLM sometimes invents neighbouring labels. The caller also
        # validates, but doing it here keeps the 502 schema-mismatch path
        # tight and the HTTP response tidy.
        allowed = {e.slug for e in req.tax_sections}
        raw_sections = data.get("tax_sections")
        if isinstance(raw_sections, list):
            data["tax_sections"] = [
                s for s in raw_sections
                if isinstance(s, dict) and s.get("slug") in allowed
            ]

    # Coerce into ClassifyResponse; missing fields raise a 422 back to the caller
    # which is fine — that is a bug signal worth surfacing.
    try:
        return ClassifyResponse(**data)
    except Exception as exc:
        log.warning("LLM payload did not match schema: %r", data)
        raise HTTPException(status_code=502, detail=f"schema mismatch: {exc}") from exc


# ─── /recap-title ──────────────────────────────────────────────────────────────


class RecapTitleRequest(BaseModel):
    """Context for an auto-generated photo-recap (Rückblick) title.

    All fields are optional — the LLM uses what's provided. ``kind`` is the
    only hint about the recap type; everything else is additional signal.
    """

    kind: str = Field(..., min_length=1)
    locale: str = "de"
    place_city: str | None = None
    place_country: str | None = None
    date_range: str | None = None
    years_ago: int | None = None
    person_name: str | None = None
    year: int | None = None
    month_label: str | None = None
    photo_count: int | None = None
    # Optional free-form keywords from image tags / embedding clusters —
    # helpful for "theme" recaps, harmless for the others.
    keywords: list[str] = Field(default_factory=list)


class RecapTitleResponse(BaseModel):
    title: str
    subtitle: str | None = None


_RECAP_SYSTEM_PROMPT = """Du erzeugst kurze, warmherzige Titel für private Foto-Rückblicke.
Antworte ausschließlich mit gültigem JSON (UTF-8, ohne Markdown-Fences).

Felder:
- title: max. 40 Zeichen, aussagekräftig, deutsch, ohne Anführungszeichen,
  ohne Emojis, ohne Ausrufezeichen. Keine Marken- oder Personennamen
  erfinden — nur die im Kontext genannten nutzen.
- subtitle: max. 80 Zeichen, ergänzender Untertitel (z.B. Zeitraum, Ort).
  null wenn nichts Sinnvolles ergänzbar ist.

Ton: freundlich, nüchtern, erinnerungsvoll. Keine Floskeln wie "Zurück in
der Zeit". Vermeide Redundanz zwischen Titel und Untertitel."""


def _recap_context(req: RecapTitleRequest) -> str:
    parts: list[str] = [f"Art des Rückblicks: {req.kind}"]
    if req.person_name:
        parts.append(f"Person: {req.person_name}")
    if req.place_city:
        parts.append(f"Ort: {req.place_city}")
    if req.place_country and req.place_country != req.place_city:
        parts.append(f"Land: {req.place_country}")
    if req.date_range:
        parts.append(f"Zeitraum: {req.date_range}")
    if req.year is not None:
        parts.append(f"Jahr: {req.year}")
    if req.years_ago is not None:
        parts.append(f"Vor {req.years_ago} Jahr(en)")
    if req.month_label:
        parts.append(f"Monat: {req.month_label}")
    if req.photo_count is not None:
        parts.append(f"Fotos: {req.photo_count}")
    if req.keywords:
        parts.append("Stichwörter: " + ", ".join(req.keywords[:8]))
    return "\n".join(parts)


@app.post("/recap-title", response_model=RecapTitleResponse)
async def recap_title(req: RecapTitleRequest) -> RecapTitleResponse:
    llm = _state["llm"]
    if llm is None:
        raise HTTPException(status_code=503, detail="llm not loaded")

    user_prompt = (
        f"Kontext:\n{_recap_context(req)}\n\n"
        "Erzeuge einen passenden Titel (und optional Untertitel) als JSON "
        "mit den Feldern title und subtitle."
    )

    try:
        completion = llm.create_chat_completion(
            messages=[
                {"role": "system", "content": _RECAP_SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            response_format={"type": "json_object"},
            temperature=0.5,
            max_tokens=160,
        )
    except Exception as exc:
        log.exception("llm.create_chat_completion failed for /recap-title")
        raise HTTPException(status_code=500, detail=f"llm failure: {exc}") from exc

    raw = completion["choices"][0]["message"]["content"].strip()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        log.warning("/recap-title: LLM returned non-JSON: %r", raw[:200])
        raise HTTPException(status_code=502, detail=f"llm returned invalid JSON: {exc}") from exc

    title = str(data.get("title") or "").strip()
    if not title:
        raise HTTPException(status_code=502, detail="llm returned empty title")
    # Hard-cap lengths so we never push excessive text into the DB/UI.
    title = title[:60]
    subtitle_raw = data.get("subtitle")
    subtitle = str(subtitle_raw).strip()[:120] if subtitle_raw else None
    if subtitle == "":
        subtitle = None
    return RecapTitleResponse(title=title, subtitle=subtitle)

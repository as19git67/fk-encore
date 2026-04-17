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


class ClassifyRequest(BaseModel):
    text: str = Field(..., min_length=1)
    taxonomy: list[TaxonomyNode] = Field(..., min_length=1)
    # Optional hints: sender hint from OCR, upload filename, user locale.
    locale: str = "de"
    max_tags: int = 6


class ClassifyResponse(BaseModel):
    category_slug: str
    title: str
    doc_date: str | None = None
    sender: str | None = None
    summary: str
    tags: list[str]
    confidence: float = Field(..., ge=0.0, le=1.0)


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


@app.post("/classify", response_model=ClassifyResponse)
async def classify(req: ClassifyRequest) -> ClassifyResponse:
    llm = _state["llm"]
    if llm is None:
        raise HTTPException(status_code=503, detail="llm not loaded")

    # Cap the document text so prompt + response stay within n_ctx on a 3B model.
    # ~6000 chars ≈ 1500–2000 tokens, leaves plenty of room for the system prompt,
    # the taxonomy and the response.
    text = req.text[:6000]

    user_prompt = (
        f"Taxonomie (slug: Name):\n{_taxonomy_outline(req.taxonomy)}\n\n"
        f"Max. Tags: {req.max_tags}\n\n"
        f"Dokumenttext:\n---\n{text}\n---"
    )

    try:
        completion = llm.create_chat_completion(
            messages=[
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            response_format={"type": "json_object"},
            temperature=0.2,
            max_tokens=512,
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

    # Coerce into ClassifyResponse; missing fields raise a 422 back to the caller
    # which is fine — that is a bug signal worth surfacing.
    try:
        return ClassifyResponse(**data)
    except Exception as exc:
        log.warning("LLM payload did not match schema: %r", data)
        raise HTTPException(status_code=502, detail=f"schema mismatch: {exc}") from exc

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

import asyncio
import functools
import json
import logging
import os
import re
import resource
import signal
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator, Callable, TypeVar

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


def _rss_mb() -> float:
    """Resident-set size of the current process in MB. Linux ``ru_maxrss`` is
    reported in KB; on macOS it would be bytes, but the container target is
    Linux so we don't bother distinguishing."""

    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024


def _install_shutdown_logging(startup_monotonic: float) -> None:
    """Wrap uvicorn's SIGTERM/SIGINT handlers so we get a log line with
    uptime and RSS when the process is asked to exit.

    Context: the service has been observed restarting every ~60-90 s with no
    error in the logs before the restart. That pattern is consistent with an
    external signal (compose stop / orchestrator / OOM of a sibling) or an
    OOM kill of this process itself. SIGKILL (OOM) is not catchable so it
    will still be silent — but if the cause is SIGTERM from the orchestrator,
    the line below pins it down the next time it happens.
    """

    def _make_handler(signum: int, previous: Any) -> Callable[[int, Any], None]:
        def _handler(sig: int, frame: Any) -> None:
            uptime = time.monotonic() - startup_monotonic
            try:
                name = signal.Signals(sig).name
            except ValueError:
                name = str(sig)
            log.warning(
                "Received %s after %.1fs uptime (RSS=%.0f MB) — shutting down",
                name, uptime, _rss_mb(),
            )
            if callable(previous):
                previous(sig, frame)
            elif previous in (signal.SIG_DFL, None):
                signal.signal(sig, signal.SIG_DFL)
                os.kill(os.getpid(), sig)
        return _handler

    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            previous = signal.getsignal(sig)
            signal.signal(sig, _make_handler(sig, previous))
        except (ValueError, OSError):
            # Not on the main thread (e.g. under TestClient) — skip. Uvicorn's
            # own handlers are also main-thread-only, so parity is fine.
            pass


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    startup_monotonic = time.monotonic()

    if not LLM_MODEL_PATH.exists():
        log.info("LLM model not found at %s. Attempting to download...", LLM_MODEL_PATH)
        import subprocess
        
        # Look for the download script in the standard container path,
        # or relative to main.py for local development.
        script_path = Path("/usr/local/bin/download_model.sh")
        if not script_path.exists():
            script_path = Path(__file__).parent / "download_model.sh"

        if script_path.exists():
            try:
                # We call the idempotent download script to populate both the GGUF
                # and the sentence-transformers cache before loading begins.
                subprocess.run([str(script_path)], check=True)
            except Exception as e:
                log.error("Auto-download failed: %s", e)
                raise RuntimeError(
                    f"LLM model not found at {LLM_MODEL_PATH} and auto-download failed. "
                    "Run download_model.sh manually to investigate."
                ) from e
        else:
            raise RuntimeError(
                f"LLM model not found at {LLM_MODEL_PATH} and download script not found at {script_path}. "
                "Please ensure the models volume is correctly populated."
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
    log.info("Llama loaded (RSS=%.0f MB)", _rss_mb())

    log.info("Loading embedder %s", EMBEDDING_MODEL)
    _state["embedder"] = SentenceTransformer(EMBEDDING_MODEL)
    log.info("Embedder loaded (RSS=%.0f MB)", _rss_mb())

    _install_shutdown_logging(startup_monotonic)
    _state["startup_monotonic"] = startup_monotonic

    log.info("Ready.")
    yield
    # Nothing to clean up — process exit releases the mmaps.


app = FastAPI(title="llm-service", version="1.0.0", lifespan=lifespan)


# ─── Blocking-call offload ─────────────────────────────────────────────────────
#
# llama-cpp-python's ``create_chat_completion`` and sentence-transformers'
# ``encode`` are synchronous and CPU-bound; calling them from the async
# handlers directly blocks the FastAPI event loop for the full inference
# duration (easily 10–60 s on a CPU-only box). While the loop is blocked,
# ``/healthz`` cannot respond, so the compose healthcheck (``curl /healthz``,
# 10 s timeout) fails, the container flips to "unhealthy" under load, and a
# concurrent ``docker compose up -d`` bails out with "dependency failed to
# start: service llm_service is unhealthy" for anything that depends on it.
#
# A single-worker executor preserves the required serialisation — a single
# ``Llama`` instance is not thread-safe, and running llama + embedder
# concurrently on one CPU only causes contention — while keeping the event
# loop free to serve the healthcheck.
_inference_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="llm-inference")
# Semaphore mirrors max_workers=1.  Callers wait up to acquire_timeout seconds
# before receiving a 503, so short operations (embed ~1 s) don't spuriously
# block a concurrent classify.  Initialised lazily on first use so it binds
# to the correct event loop.
_inference_sem: asyncio.Semaphore | None = None


def _get_inference_sem() -> asyncio.Semaphore:
    global _inference_sem
    if _inference_sem is None:
        _inference_sem = asyncio.Semaphore(1)
    return _inference_sem

_T = TypeVar("_T")


async def _run_blocking(
    func: Callable[..., _T],
    *args: Any,
    acquire_timeout: float = 10.0,
    **kwargs: Any,
) -> _T:
    """Run *func* in the shared single-worker executor.

    Waits up to *acquire_timeout* seconds for the inference semaphore.  This
    lets short operations (e.g. a ~1 s embed) finish without immediately
    returning 503 to a caller that arrived a moment too late.  Callers that
    genuinely hit a busy LLM (10–60 s inference) still get a fast 503 once
    the timeout elapses.
    """
    sem = _get_inference_sem()
    try:
        await asyncio.wait_for(sem.acquire(), timeout=acquire_timeout)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=503, detail="inference busy")
    try:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(
            _inference_executor, functools.partial(func, *args, **kwargs)
        )
    finally:
        sem.release()


# ─── UTF-8 repair ──────────────────────────────────────────────────────────────
#
# llama-cpp-python's JSON-grammar-constrained generation works at the byte
# level and occasionally emits a multi-byte UTF-8 codepoint split across two
# grammar "tokens", so ``detokenize().decode("utf-8", errors="replace")``
# inside the library can produce Latin-1 / Windows-1252 interpretations of
# the raw bytes. The classic symptom is "Brüssel" coming back as "BrÃ¼ssel"
# (the UTF-8 bytes ``C3 BC`` read as two separate Latin-1 characters).
#
# We fix this at the source — right after JSON parsing on the producer side
# — by attempting a Latin-1 → UTF-8 round-trip and keeping the repaired form
# only when it looks meaningfully different and remains valid UTF-8. The
# function is a no-op on already-clean text, so it's safe to apply
# universally to every string field we return.

_MOJIBAKE_PATTERN = re.compile(r"[ÂÃ][-¿]")


def _repair_mojibake(value: str | None) -> str | None:
    if value is None or value == "":
        return value
    if not _MOJIBAKE_PATTERN.search(value):
        return value
    try:
        repaired = value.encode("latin-1").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return value
    if "�" in repaired:
        return value
    return repaired


def _repair_fields(data: dict[str, Any], keys: tuple[str, ...]) -> None:
    """In-place ``_repair_mojibake`` for the given string keys of ``data``."""

    for key in keys:
        v = data.get(key)
        if isinstance(v, str):
            data[key] = _repair_mojibake(v)


def _repair_tags(data: dict[str, Any]) -> None:
    tags = data.get("tags")
    if isinstance(tags, list):
        data["tags"] = [_repair_mojibake(t) if isinstance(t, str) else t for t in tags]


# ─── /healthz ──────────────────────────────────────────────────────────────────


@app.get("/healthz")
async def healthz() -> dict[str, Any]:
    started = _state.get("startup_monotonic")
    uptime_s = (time.monotonic() - started) if isinstance(started, float) else None
    return {
        "status": "ok" if _state["llm"] and _state["embedder"] else "starting",
        "llm_loaded": _state["llm"] is not None,
        "embedder_loaded": _state["embedder"] is not None,
        "llm_model_path": str(LLM_MODEL_PATH),
        "embedding_model": EMBEDDING_MODEL,
        "rss_mb": round(_rss_mb(), 1),
        "uptime_s": round(uptime_s, 1) if uptime_s is not None else None,
    }


# ─── /embed ────────────────────────────────────────────────────────────────────


class EmbedRequest(BaseModel):
    texts: list[str] = Field(..., min_length=1)
    # e5-family models (``intfloat/multilingual-e5-*``, ``intfloat/e5-*``)
    # are trained with explicit ``query: `` / ``passage: `` prefixes; without
    # them retrieval quality drops by several nDCG points because query and
    # passage vectors live in subtly misaligned subspaces. Callers therefore
    # tell us what they're embedding so the service can apply the right
    # prefix. Default ``passage`` matches the corpus-side use which is the
    # more common path (every document chunk goes through here).
    kind: str = Field(default="passage", pattern="^(passage|query)$")


class EmbedResponse(BaseModel):
    embeddings: list[list[float]]
    dim: int


def _is_e5_model(name: str) -> bool:
    """E5 family detection by repo name. Covers ``intfloat/e5-*`` and
    ``intfloat/multilingual-e5-*`` variants."""

    n = name.lower()
    return n.startswith("intfloat/e5-") or n.startswith("intfloat/multilingual-e5-")


def _apply_embedding_prefix(texts: list[str], kind: str) -> list[str]:
    """Prepend the model-appropriate prefix. No-op for non-e5 models."""

    if not _is_e5_model(EMBEDDING_MODEL):
        return texts
    prefix = "query: " if kind == "query" else "passage: "
    return [prefix + t for t in texts]


@app.post("/embed", response_model=EmbedResponse)
async def embed(req: EmbedRequest) -> EmbedResponse:
    embedder = _state["embedder"]
    if embedder is None:
        raise HTTPException(status_code=503, detail="embedder not loaded")
    prepared = _apply_embedding_prefix(req.texts, req.kind)
    vectors = await _run_blocking(
        lambda: embedder.encode(prepared, normalize_embeddings=True).tolist()
    )
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


_CLASSIFY_MAX_TOKENS = 768
# Headroom for chat-template overhead (role markers, BOS/EOS, separators) that
# our raw-string token count does not see. 256 is generous for a Llama-style
# template; the alternative is to recreate the template here, which couples us
# to the model.
_CLASSIFY_TEMPLATE_HEADROOM = 256


def _count_tokens(llm: Any, text: str) -> int:
    return len(llm.tokenize(text.encode("utf-8"), add_bos=False, special=False))


@app.post("/classify", response_model=ClassifyResponse)
async def classify(req: ClassifyRequest) -> ClassifyResponse:
    llm = _state["llm"]
    if llm is None:
        raise HTTPException(status_code=503, detail="llm not loaded")

    # Initial char-cap remains as a cheap upper bound. A token-budget pass
    # below shrinks `text` further when the taxonomy + tax_sections outline
    # bloat the prompt past n_ctx (issue #325).
    text = req.text[:6000]

    tax_active = bool(req.tax_sections)
    system_prompt = _SYSTEM_PROMPT + (_TAX_SYSTEM_PROMPT if tax_active else "")

    tax_block = (
        f"\n\nSteuer-Sektionen (slug: Name — Hinweis):\n{_tax_sections_outline(req.tax_sections)}"
        if tax_active
        else ""
    )

    def _build_user_prompt(body: str) -> str:
        return (
            f"Taxonomie (slug: Name):\n{_taxonomy_outline(req.taxonomy)}{tax_block}\n\n"
            f"Max. Tags: {req.max_tags}\n\n"
            f"Dokumenttext:\n---\n{body}\n---"
        )

    user_prompt = _build_user_prompt(text)

    # Token-budget guard. The taxonomy + tax_sections outline can be several
    # thousand tokens by themselves; combined with a long document text the
    # prompt has been observed at 8691 tokens against an LLM_CTX of 8192. We
    # tokenize the actual prompt and shrink the document text until it fits.
    budget = LLM_CTX - _CLASSIFY_MAX_TOKENS - _CLASSIFY_TEMPLATE_HEADROOM
    overhead_tokens = _count_tokens(llm, system_prompt + _build_user_prompt(""))
    text_token_budget = budget - overhead_tokens
    if text_token_budget < 64:
        # Even with empty text we'd overflow — taxonomy/tax_sections alone are
        # too large. Surface a 413 so the caller can act on it instead of
        # hitting llama.cpp's 500.
        raise HTTPException(
            status_code=413,
            detail=(
                f"taxonomy+tax_sections too large for context window: "
                f"overhead={overhead_tokens} budget={budget}"
            ),
        )

    text_tokens = llm.tokenize(text.encode("utf-8"), add_bos=False, special=False)
    if len(text_tokens) > text_token_budget:
        truncated = llm.detokenize(text_tokens[:text_token_budget])
        if isinstance(truncated, bytes):
            text = truncated.decode("utf-8", errors="ignore")
        else:
            text = str(truncated)
        log.info(
            "classify: truncated document text from %d to %d tokens to fit n_ctx",
            len(text_tokens), text_token_budget,
        )
        user_prompt = _build_user_prompt(text)

    try:
        completion = await _run_blocking(
            llm.create_chat_completion,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            response_format={"type": "json_object"},
            temperature=0.2,
            # _CLASSIFY_MAX_TOKENS leaves headroom for the extra tax fields
            # (up to a handful of tax_sections entries) without touching n_ctx.
            max_tokens=_CLASSIFY_MAX_TOKENS,
        )
    except HTTPException:
        raise
    except Exception as exc:  # llama.cpp raises a generic Exception family
        log.exception("llm.create_chat_completion failed")
        raise HTTPException(status_code=500, detail=f"llm failure: {exc}") from exc

    raw = completion["choices"][0]["message"]["content"].strip()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        log.warning("LLM returned non-JSON payload: %r", raw[:200])
        raise HTTPException(status_code=502, detail=f"llm returned invalid JSON: {exc}") from exc

    # Repair UTF-8-as-Latin-1 mojibake at the producer boundary — see the
    # ``_repair_mojibake`` docstring above. Only the free-form German text
    # fields can contain the two-byte UTF-8 codepoints (ä/ö/ü/ß, umlauts) that
    # trigger the bug; slugs, dates and confidences are ASCII.
    _repair_fields(data, ("title", "sender", "summary"))
    _repair_tags(data)

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
        # LLM sometimes emits null for numeric confidence fields — coerce to defaults.
        if data.get("tax_year_confidence") is None:
            data["tax_year_confidence"] = 0.0

    # Coerce into ClassifyResponse; missing fields raise a 422 back to the caller
    # which is fine — that is a bug signal worth surfacing.
    try:
        return ClassifyResponse(**data)
    except Exception as exc:
        log.warning("LLM payload did not match schema: %r", data)
        raise HTTPException(status_code=502, detail=f"schema mismatch: {exc}") from exc


# ─── /json-prompt ──────────────────────────────────────────────────────────────


class JsonPromptRequest(BaseModel):
    """Generic JSON-mode chat completion.

    Used by callers whose prompt isn't the hardcoded document classifier
    (e.g. finance tag-suggestion, free-text-to-AST analysis queries). The
    server only enforces ``response_format={"type": "json_object"}``; the
    caller is responsible for prompting the LLM into the desired shape and
    validating the response.
    """

    prompt: str = Field(..., min_length=1)
    system: str | None = None
    max_tokens: int = Field(default=768, gt=0, le=4096)
    temperature: float = Field(default=0.2, ge=0.0, le=2.0)


@app.post("/json-prompt")
async def json_prompt(req: JsonPromptRequest) -> dict[str, Any]:
    llm = _state["llm"]
    if llm is None:
        raise HTTPException(status_code=503, detail="llm not loaded")

    messages: list[dict[str, str]] = []
    if req.system:
        messages.append({"role": "system", "content": req.system})
    messages.append({"role": "user", "content": req.prompt})

    try:
        completion = await _run_blocking(
            llm.create_chat_completion,
            messages=messages,
            response_format={"type": "json_object"},
            temperature=req.temperature,
            max_tokens=req.max_tokens,
        )
    except HTTPException:
        raise
    except Exception as exc:
        log.exception("/json-prompt: llm.create_chat_completion failed")
        raise HTTPException(status_code=500, detail=f"llm failure: {exc}") from exc

    raw = completion["choices"][0]["message"]["content"].strip()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        log.warning("/json-prompt: LLM returned non-JSON: %r", raw[:200])
        raise HTTPException(status_code=502, detail=f"llm returned invalid JSON: {exc}") from exc

    if not isinstance(data, dict):
        raise HTTPException(status_code=502, detail="llm returned non-object JSON")

    # Mojibake repair on shallow string fields — same fix as /classify, only
    # applied to top-level strings and string list members. Finance prompts
    # don't return nested objects, so we don't recurse.
    for k, v in list(data.items()):
        if isinstance(v, str):
            data[k] = _repair_mojibake(v)
        elif isinstance(v, list):
            data[k] = [_repair_mojibake(x) if isinstance(x, str) else x for x in v]

    return data


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
        completion = await _run_blocking(
            llm.create_chat_completion,
            messages=[
                {"role": "system", "content": _RECAP_SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            response_format={"type": "json_object"},
            temperature=0.5,
            max_tokens=160,
        )
    except HTTPException:
        raise
    except Exception as exc:
        log.exception("llm.create_chat_completion failed for /recap-title")
        raise HTTPException(status_code=500, detail=f"llm failure: {exc}") from exc

    raw = completion["choices"][0]["message"]["content"].strip()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        log.warning("/recap-title: LLM returned non-JSON: %r", raw[:200])
        raise HTTPException(status_code=502, detail=f"llm returned invalid JSON: {exc}") from exc

    title_raw = str(data.get("title") or "").strip()
    if not title_raw:
        raise HTTPException(status_code=502, detail="llm returned empty title")
    # Repair UTF-8-as-Latin-1 mojibake at the producer boundary before the
    # string ever reaches the Encore caller / DB. llama-cpp-python with the
    # JSON-grammar response format splits tokens at multi-byte UTF-8
    # boundaries and occasionally re-decodes a ``C3 BC`` codepoint as two
    # separate Latin-1 chars ("ü" → "Ã¼"). See ``_repair_mojibake`` above.
    title = (_repair_mojibake(title_raw) or "")[:60]
    subtitle_raw = data.get("subtitle")
    subtitle = (_repair_mojibake(str(subtitle_raw).strip()) or "")[:120] if subtitle_raw else None
    if subtitle == "":
        subtitle = None
    return RecapTitleResponse(title=title, subtitle=subtitle)

"""taxonomy-tools sidecar — runs the offline taxonomy scripts on demand.

Exposes four tools (diagnose, cloud-audit, cloud-teacher, scoreboard) as
FastAPI endpoints. Each spawns the underlying script as a subprocess and
streams its stdout/stderr back as Server-Sent Events, so the admin frontend
can show a live log.

Only one run per tool is allowed at a time (mutex per tool name).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import signal
import time
from enum import Enum
from typing import Any

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
)
log = logging.getLogger("taxonomy-tools")

app = FastAPI(title="taxonomy-tools", version="1.0.0")

SCRIPTS_DIR = os.environ.get("SCRIPTS_DIR", "/app/scripts/taxonomy")
TS_SOURCES_DIR = os.environ.get("TS_SOURCES_DIR", "/app/ts-sources")


class ToolName(str, Enum):
    diagnose = "diagnose"
    cloud_audit = "cloud-audit"
    cloud_teacher = "cloud-teacher"
    scoreboard = "scoreboard"


# The scoreboard's label ends up in a filename and reaches us from an admin
# form, so pin it to characters that cannot walk out of out/ or confuse the
# glob that finds snapshots again. Mirrors _LABEL_RE in model_scoreboard.py.
LABEL_RE = re.compile(r"^[A-Za-z0-9._-]{1,40}$")


class RunOptions(BaseModel):
    dry_run: bool = False
    batch: int | None = Field(None, ge=1, le=5000)
    sample: int | None = Field(None, ge=1, le=5000)
    tax_sample: int | None = Field(None, ge=1, le=5000)
    focus_sections: str | None = None
    focus_categories: str | None = None
    # scoreboard only: the name this measurement is filed under (usually the
    # model), and optionally an earlier label to compare it against.
    label: str | None = Field(None, pattern=LABEL_RE.pattern)
    compare_with: str | None = Field(None, pattern=LABEL_RE.pattern)


_locks: dict[ToolName, asyncio.Lock] = {t: asyncio.Lock() for t in ToolName}
_running: dict[ToolName, asyncio.subprocess.Process | None] = {t: None for t in ToolName}


def _build_command(tool: ToolName, opts: RunOptions) -> list[str]:
    if tool == ToolName.diagnose:
        return ["node", f"{SCRIPTS_DIR}/diagnose.mjs"]
    elif tool == ToolName.cloud_audit:
        return ["python3", f"{SCRIPTS_DIR}/cloud_audit.py"]
    elif tool == ToolName.cloud_teacher:
        return ["python3", f"{SCRIPTS_DIR}/cloud_teacher.py"]
    elif tool == ToolName.scoreboard:
        # Unlike the others this one takes arguments rather than environment
        # variables, because the label is part of the output filename and the
        # script validates it as such.
        if not opts.label:
            raise HTTPException(400, "scoreboard needs a label")
        cmd = ["python3", f"{SCRIPTS_DIR}/model_scoreboard.py", "--label", opts.label]
        if opts.compare_with:
            cmd += ["--compare-with", opts.compare_with]
        return cmd
    raise ValueError(f"unknown tool: {tool}")


def _build_env(tool: ToolName, opts: RunOptions) -> dict[str, str]:
    env = {**os.environ}
    # Python scripts use _common.py which reads TS source files relative to
    # REPO_ROOT (2 levels up from the script directory). Since our scripts are
    # at /app/scripts/taxonomy, REPO_ROOT resolves to /app — and that's where
    # we put the ts-sources under /app/documents/.
    # No REPO_ROOT override needed — the path arithmetic in _common.py works.

    if tool == ToolName.diagnose:
        if opts.sample is not None:
            env["CONFUSION_SAMPLE"] = str(opts.sample)
    elif tool == ToolName.cloud_audit:
        if opts.dry_run:
            env["AUDIT_DRY_RUN"] = "1"
        if opts.sample is not None:
            env["AUDIT_SAMPLE"] = str(opts.sample)
        if opts.tax_sample is not None:
            env["AUDIT_TAX_SAMPLE"] = str(opts.tax_sample)
        if opts.focus_sections:
            env["AUDIT_TAX_FOCUS_SECTIONS"] = opts.focus_sections
    elif tool == ToolName.cloud_teacher:
        if opts.dry_run:
            env["TEACHER_DRY_RUN"] = "1"
        if opts.batch is not None:
            env["TEACHER_BATCH"] = str(opts.batch)
        if opts.focus_categories:
            env["TEACHER_FOCUS_CATEGORIES"] = opts.focus_categories

    # Force unbuffered Python output so SSE lines arrive immediately.
    env["PYTHONUNBUFFERED"] = "1"
    return env


@app.get("/health")
async def health() -> dict[str, Any]:
    running = {t.value: _running[t] is not None for t in ToolName}
    return {"status": "ok", "running": running}


@app.post("/run/{tool}")
async def run_tool(tool: ToolName, opts: RunOptions | None = None):
    if opts is None:
        opts = RunOptions()

    lock = _locks[tool]
    if lock.locked():
        raise HTTPException(409, f"{tool.value} is already running")

    # Validated before the stream opens: an SSE response has already committed
    # to 200, so a bad label would otherwise surface as a log line rather than
    # as a rejected request.
    _build_command(tool, opts)

    async def event_stream():
        async with lock:
            cmd = _build_command(tool, opts)
            env = _build_env(tool, opts)
            start = time.monotonic()
            log.info("%s: starting (%s)", tool.value, " ".join(cmd))
            yield {"event": "start", "data": f"Starting {tool.value} ..."}

            try:
                proc = await asyncio.create_subprocess_exec(
                    *cmd,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.STDOUT,
                    env=env,
                )
                _running[tool] = proc

                assert proc.stdout is not None
                async for raw_line in proc.stdout:
                    line = raw_line.decode("utf-8", errors="replace").rstrip("\n")
                    # Mirror into the container log as well as the SSE stream.
                    # The stream is the only other consumer of this pipe, so
                    # without this a run is invisible to `docker compose logs`
                    # — and completely invisible if the relay to the browser is
                    # not working (which is exactly when the log is needed).
                    log.info("%s | %s", tool.value, line)
                    yield {"event": "log", "data": line}

                code = await proc.wait()
                elapsed = round(time.monotonic() - start, 1)

                if code == 0:
                    log.info("%s: finished in %ss (exit 0)", tool.value, elapsed)
                    yield {"event": "done", "data": f"Finished in {elapsed}s (exit 0)"}
                else:
                    log.error("%s: exited with code %s after %ss", tool.value, code, elapsed)
                    yield {"event": "error", "data": f"Exited with code {code} after {elapsed}s"}
            except asyncio.CancelledError:
                log.warning("%s: cancelled", tool.value)
                if _running.get(tool):
                    _running[tool].terminate()  # type: ignore[union-attr]
                yield {"event": "error", "data": "Cancelled"}
            finally:
                _running[tool] = None

    return EventSourceResponse(event_stream())


@app.post("/cancel/{tool}")
async def cancel_tool(tool: ToolName):
    proc = _running.get(tool)
    if proc is None:
        raise HTTPException(404, f"{tool.value} is not running")
    try:
        proc.send_signal(signal.SIGTERM)
    except ProcessLookupError:
        pass
    return JSONResponse({"status": "cancelled"})


# Base filenames (without date prefix) each tool can produce.  The actual
# scripts prepend a YYYY-MM-DD- date prefix (e.g. "2026-07-28-diagnose.md").
# _find_report_files() resolves the latest date-prefixed variant on disk.
_REPORT_BASES: dict[ToolName, list[str]] = {
    ToolName.diagnose: ["diagnose.md"],
    ToolName.cloud_audit: [
        "cloud_audit.md",
        "cloud_audit_gold.json",
        "cloud_audit_dry_run.jsonl",
    ],
    ToolName.cloud_teacher: [
        "cloud_teacher.md",
        "cloud_teacher_labels.json",
        "cloud_teacher_dry_run.jsonl",
    ],
}

_DATE_PREFIX_RE = re.compile(r"^\d{4}-\d{2}-\d{2}-")

# The scoreboard files carry the run's label in the name
# ("2026-08-15-scoreboard-qwen3-14b.md"), so there is no fixed base to look up.
# They are also worth keeping several of — the whole point is comparing runs —
# so this tool lists a history rather than one newest file per name.
_REPORT_PATTERNS: dict[ToolName, re.Pattern[str]] = {
    ToolName.scoreboard: re.compile(
        r"^\d{4}-\d{2}-\d{2}-scoreboard[-_][A-Za-z0-9._-]{1,40}\.(?:md|json)$"
    ),
}

# How many scoreboard files to offer at once. Enough for a handful of
# candidates measured on the same day, short of an unbounded list.
_PATTERN_REPORT_LIMIT = 20

CONTENT_TYPES: dict[str, str] = {
    ".md": "text/markdown; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".jsonl": "application/x-ndjson; charset=utf-8",
}


def _latest_dated(out_dir: Path, base: str) -> Path | None:
    """Newest date-prefixed variant of *base* in *out_dir*, or the exact
    (legacy, non-prefixed) name if that's what's there."""
    exact = out_dir / base
    if exact.is_file():
        return exact
    candidates = sorted(out_dir.glob(f"*-{base}"), reverse=True)
    for c in candidates:
        prefix = c.name[: len(c.name) - len(base)]
        if _DATE_PREFIX_RE.match(prefix):
            return c
    return None


def _find_report_files(tool: ToolName) -> list[Path]:
    """Return the latest date-prefixed variant of each expected report file."""
    out_dir = Path(SCRIPTS_DIR) / "out"
    if not out_dir.is_dir():
        return []

    pattern = _REPORT_PATTERNS.get(tool)
    if pattern is not None:
        matches = [p for p in out_dir.iterdir() if p.is_file() and pattern.match(p.name)]
        matches.sort(key=lambda p: p.stat().st_mtime, reverse=True)
        return matches[:_PATTERN_REPORT_LIMIT]

    bases = _REPORT_BASES.get(tool, [])
    result: list[Path] = []
    for base in bases:
        found = _latest_dated(out_dir, base)
        if found is not None:
            result.append(found)
    return result


# The cloud-audit reference the scoreboard measures against by default (see
# model_scoreboard.py's _load_reference). Not in _REPORT_BASES/downloadable —
# it's Claude's per-document judgement on the whole sample, an internal
# working file rather than an operator-facing report.
_REFERENCE_BASE = "cloud_audit_full.json"


@app.get("/scoreboard/reference-doc-ids")
async def scoreboard_reference_doc_ids():
    """Document IDs the current cloud-audit reference covers.

    Lets the app re-run the classification pipeline over exactly this set
    before a scoreboard measurement, so the DB reflects the model actually
    being scored rather than whatever last classified these documents.
    """
    out_dir = Path(SCRIPTS_DIR) / "out"
    path = _latest_dated(out_dir, _REFERENCE_BASE) if out_dir.is_dir() else None
    if path is None:
        raise HTTPException(404, f"no {_REFERENCE_BASE} found — run cloud-audit first")

    try:
        rows = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        raise HTTPException(500, f"{path.name} is unreadable: {exc}") from exc

    # ERROR rows are documents Claude never actually judged (see cloud_audit's
    # _classify_batch) — nothing to compare against, so no reason to reclassify them.
    doc_ids = sorted({
        int(r["doc_id"]) for r in rows if isinstance(r, dict) and r.get("claude_slug") not in (None, "ERROR")
    })
    return {"source": path.name, "doc_ids": doc_ids}


@app.get("/reports/{tool}")
async def list_reports(tool: ToolName):
    files = []
    for p in _find_report_files(tool):
        stat = p.stat()
        files.append({
            "name": p.name,
            "size": stat.st_size,
            "modified": stat.st_mtime,
        })
    return {"files": files}


def _is_allowed_report(tool: ToolName, filename: str) -> bool:
    """Check that filename matches a known report pattern for the tool."""
    pattern = _REPORT_PATTERNS.get(tool)
    if pattern is not None:
        return bool(pattern.match(filename))

    bases = _REPORT_BASES.get(tool, [])
    for base in bases:
        if filename == base:
            return True
        prefix = filename[: len(filename) - len(base)]
        if filename.endswith(base) and _DATE_PREFIX_RE.match(prefix):
            return True
    return False


@app.get("/reports/{tool}/{filename}")
async def download_report(tool: ToolName, filename: str):
    if not _is_allowed_report(tool, filename):
        raise HTTPException(404, f"unknown report file: {filename}")
    out_dir = Path(SCRIPTS_DIR) / "out"
    path = out_dir / filename
    if not path.is_file():
        raise HTTPException(404, f"report not found: {filename}")
    suffix = path.suffix.lower()
    media_type = CONTENT_TYPES.get(suffix, "application/octet-stream")
    return FileResponse(path, media_type=media_type, filename=filename)

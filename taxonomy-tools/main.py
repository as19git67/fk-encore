"""taxonomy-tools sidecar — runs the offline taxonomy scripts on demand.

Exposes three tools (diagnose, cloud-audit, cloud-teacher) as FastAPI
endpoints. Each spawns the underlying script as a subprocess and streams
its stdout/stderr back as Server-Sent Events, so the admin frontend can
show a live log.

Only one run per tool is allowed at a time (mutex per tool name).
"""

from __future__ import annotations

import asyncio
import os
import signal
import time
from enum import Enum
from typing import Any

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse

app = FastAPI(title="taxonomy-tools", version="1.0.0")

SCRIPTS_DIR = os.environ.get("SCRIPTS_DIR", "/app/scripts/taxonomy")
TS_SOURCES_DIR = os.environ.get("TS_SOURCES_DIR", "/app/ts-sources")


class ToolName(str, Enum):
    diagnose = "diagnose"
    cloud_audit = "cloud-audit"
    cloud_teacher = "cloud-teacher"


class RunOptions(BaseModel):
    dry_run: bool = False
    batch: int | None = Field(None, ge=1, le=5000)
    sample: int | None = Field(None, ge=1, le=5000)
    tax_sample: int | None = Field(None, ge=1, le=5000)
    focus_sections: str | None = None
    focus_categories: str | None = None


_locks: dict[ToolName, asyncio.Lock] = {t: asyncio.Lock() for t in ToolName}
_running: dict[ToolName, asyncio.subprocess.Process | None] = {t: None for t in ToolName}


def _build_command(tool: ToolName) -> list[str]:
    if tool == ToolName.diagnose:
        return ["node", f"{SCRIPTS_DIR}/diagnose.mjs"]
    elif tool == ToolName.cloud_audit:
        return ["python3", f"{SCRIPTS_DIR}/cloud_audit.py"]
    elif tool == ToolName.cloud_teacher:
        return ["python3", f"{SCRIPTS_DIR}/cloud_teacher.py"]
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

    async def event_stream():
        async with lock:
            cmd = _build_command(tool)
            env = _build_env(tool, opts)
            start = time.monotonic()
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
                    yield {"event": "log", "data": line}

                code = await proc.wait()
                elapsed = round(time.monotonic() - start, 1)

                if code == 0:
                    yield {"event": "done", "data": f"Finished in {elapsed}s (exit 0)"}
                else:
                    yield {"event": "error", "data": f"Exited with code {code} after {elapsed}s"}
            except asyncio.CancelledError:
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


import re

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

CONTENT_TYPES: dict[str, str] = {
    ".md": "text/markdown; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".jsonl": "application/x-ndjson; charset=utf-8",
}


def _find_report_files(tool: ToolName) -> list[Path]:
    """Return the latest date-prefixed variant of each expected report file."""
    out_dir = Path(SCRIPTS_DIR) / "out"
    if not out_dir.is_dir():
        return []

    bases = _REPORT_BASES.get(tool, [])
    result: list[Path] = []
    for base in bases:
        # Try exact name first (legacy / non-prefixed).
        exact = out_dir / base
        if exact.is_file():
            result.append(exact)
            continue
        # Glob for date-prefixed variants and pick the newest.
        candidates = sorted(out_dir.glob(f"*-{base}"), reverse=True)
        for c in candidates:
            prefix = c.name[: len(c.name) - len(base)]
            if _DATE_PREFIX_RE.match(prefix):
                result.append(c)
                break
    return result


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

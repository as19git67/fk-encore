"""Fetching and managing GGUF files on the models volume.

``download_model.sh`` still handles the cold-start case at container boot. This
module covers the other one: an operator adding a *new* model from the admin UI
while the service is running, which needs progress reporting, cancellation and
a way to see what is already on disk — none of which a fire-and-forget shell
script can provide.

Downloads run one at a time. Two multi-gigabyte transfers to the same spindle
finish no sooner than one after the other, and serialising keeps "how full is
the volume" answerable.

stdlib-only, like llama_server.py: this service's dependency list is already
long and a downloader is not worth extending it for.
"""

from __future__ import annotations

import hashlib
import logging
import os
import threading
import time
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import unquote, urlparse

log = logging.getLogger("llm-service.downloads")

CHUNK = 1024 * 1024
# Long enough to ride out a slow mirror, short enough that a dead connection
# does not pin the job forever. Applies per read, not to the whole transfer.
SOCKET_TIMEOUT = 60.0

# urllib's default User-Agent ("Python-urllib/3.x") gets a 401/403 from
# Hugging Face's CDN, which treats it as scraper traffic — curl and browsers
# work fine with the same URL. download_model.sh (curl-based) never hit this;
# this module does its own HTTP and needs its own UA.
DOWNLOAD_USER_AGENT = "fk-encore-llm-service/1.0 (+model-downloader)"

# Files we consider "a model" when listing the volume. The service only ever
# loads GGUF; anything else on the volume (the embedder cache, the active-config
# file) is not the operator's business here.
MODEL_SUFFIXES = (".gguf",)


class DownloadError(RuntimeError):
    pass


def safe_filename(name: str) -> str:
    """Reject anything that is not a bare file name.

    These names arrive over HTTP and are joined onto the models directory; a
    path separator or a ``..`` would let a request write outside the volume.
    """

    cleaned = (name or "").strip()
    if not cleaned:
        raise DownloadError("file name must not be empty")
    if "/" in cleaned or "\\" in cleaned or cleaned in {".", ".."}:
        raise DownloadError(f"{cleaned!r} is not a bare file name")
    if cleaned.startswith("."):
        raise DownloadError("file name must not start with a dot")
    return cleaned


def filename_from_url(url: str) -> str:
    """Basename a URL points at, query string stripped — the same rule
    download_model.sh applies to LLM_MODEL_EXTRA_URLS."""

    path = urlparse(url).path
    return safe_filename(unquote(path.rsplit("/", 1)[-1]))


def list_model_files(models_dir: Path) -> list[dict[str, Any]]:
    """Model files present on the volume, largest first.

    Partially-downloaded files are included and flagged, because "3 of 26 GB
    landed before the network dropped" is exactly what an operator looking at
    this list needs to know.
    """

    if not models_dir.is_dir():
        return []
    out: list[dict[str, Any]] = []
    for entry in models_dir.iterdir():
        if not entry.is_file():
            continue
        partial = entry.name.endswith(".part")
        stem = entry.name[: -len(".part")] if partial else entry.name
        if not stem.lower().endswith(MODEL_SUFFIXES):
            continue
        stat = entry.stat()
        out.append(
            {
                "filename": entry.name,
                "size_bytes": stat.st_size,
                "modified_at": stat.st_mtime,
                "partial": partial,
            }
        )
    out.sort(key=lambda f: f["size_bytes"], reverse=True)
    return out


def disk_usage(models_dir: Path) -> dict[str, int | None]:
    """Space on the models volume. Nulls rather than an error when the
    directory is not there — a missing volume is a deployment problem, not a
    reason for the endpoint listing it to fail."""

    try:
        usage = os.statvfs(models_dir)
    except OSError:
        return {"total_bytes": None, "free_bytes": None}
    return {
        "total_bytes": usage.f_blocks * usage.f_frsize,
        "free_bytes": usage.f_bavail * usage.f_frsize,
    }


def delete_model_file(models_dir: Path, filename: str) -> None:
    target = models_dir / safe_filename(filename)
    if not target.is_file():
        raise FileNotFoundError(f"{filename} is not on the models volume")
    target.unlink()
    log.info("Deleted model file %s", target)


@dataclass
class DownloadTarget:
    url: str
    filename: str


@dataclass
class DownloadStatus:
    """Snapshot of the manager, safe to serialise straight into a response."""

    state: str = "idle"  # idle | downloading | verifying | done | error | cancelled
    filename: str = ""
    url: str = ""
    bytes_done: int = 0
    bytes_total: int | None = None
    file_index: int = 0
    file_count: int = 0
    started_at: float | None = None
    finished_at: float | None = None
    error: str | None = None
    # Averaged over the whole job rather than instantaneous: an ETA that jumps
    # around with every TCP hiccup is worse than no ETA.
    bytes_per_second: float | None = None
    completed: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        total = self.bytes_total
        if self.state == "downloading" and total and self.bytes_per_second:
            remaining = max(total - self.bytes_done, 0)
            data["eta_seconds"] = round(remaining / self.bytes_per_second, 1)
        else:
            data["eta_seconds"] = None
        data["percent"] = round(self.bytes_done / total * 100, 1) if total else None
        return data


class DownloadManager:
    """One download job at a time, run on a background thread."""

    def __init__(self, models_dir: Path) -> None:
        self._models_dir = models_dir
        self._lock = threading.Lock()
        self._status = DownloadStatus()
        self._thread: threading.Thread | None = None
        self._cancel = threading.Event()

    # ── query ────────────────────────────────────────────────────────────────

    @property
    def busy(self) -> bool:
        thread = self._thread
        return thread is not None and thread.is_alive()

    def status(self) -> dict[str, Any]:
        with self._lock:
            return self._status.to_dict()

    # ── control ──────────────────────────────────────────────────────────────

    def start(self, targets: Iterable[DownloadTarget], *, sha256: str = "") -> None:
        """Queue *targets* for download. The first one's checksum is verified
        when *sha256* is given — shards are not individually checksummed
        because publishers rarely list per-shard digests."""

        items = list(targets)
        if not items:
            raise DownloadError("no download targets given")
        for item in items:
            safe_filename(item.filename)
            if not item.url.startswith(("http://", "https://")):
                raise DownloadError(f"{item.url!r} is not an http(s) URL")

        with self._lock:
            if self.busy:
                raise DownloadError("a download is already running")
            self._cancel.clear()
            self._status = DownloadStatus(
                state="downloading",
                filename=items[0].filename,
                url=items[0].url,
                file_count=len(items),
                started_at=time.time(),
            )
            self._thread = threading.Thread(
                target=self._run, args=(items, sha256), name="model-download", daemon=True
            )
            self._thread.start()

    def run_blocking(self, targets: Iterable[DownloadTarget], *, sha256: str = "") -> None:
        """Download on the calling thread and raise on failure.

        Used at startup, where there is no one to report progress to yet — the
        app is not serving requests until the lifespan finishes — and where a
        failed download must abort the start rather than be discovered later
        through a status endpoint.
        """

        items = list(targets)
        with self._lock:
            if self.busy:
                raise DownloadError("a download is already running")
            self._cancel.clear()
            self._status = DownloadStatus(
                state="downloading",
                filename=items[0].filename if items else "",
                file_count=len(items),
                started_at=time.time(),
            )
        self._run(items, sha256)
        status = self.status()
        if status["state"] != "done":
            raise DownloadError(status["error"] or f"download ended in state {status['state']}")

    def cancel(self) -> bool:
        """Ask the running job to stop. The ``.part`` file is deliberately kept
        so the next attempt resumes instead of starting over."""

        if not self.busy:
            return False
        self._cancel.set()
        return True

    # ── worker ───────────────────────────────────────────────────────────────

    def _run(self, targets: list[DownloadTarget], sha256: str) -> None:
        try:
            for index, target in enumerate(targets):
                if self._cancel.is_set():
                    self._finish("cancelled")
                    return
                with self._lock:
                    self._status.filename = target.filename
                    self._status.url = target.url
                    self._status.file_index = index
                    self._status.bytes_done = 0
                    self._status.bytes_total = None
                path = self._download_one(target)
                if path is None:  # cancelled mid-transfer
                    self._finish("cancelled")
                    return
                if index == 0 and sha256:
                    with self._lock:
                        self._status.state = "verifying"
                    self._verify(path, sha256)
                with self._lock:
                    self._status.completed.append(target.filename)
                    self._status.state = "downloading"
            self._finish("done")
        except Exception as exc:  # noqa: BLE001 — surfaced through status
            log.exception("Download failed")
            self._finish("error", error=f"{type(exc).__name__}: {exc}")

    def _download_one(self, target: DownloadTarget) -> Path | None:
        final = self._models_dir / target.filename
        if final.exists():
            log.info("%s already present — skipping", final)
            with self._lock:
                self._status.bytes_done = final.stat().st_size
                self._status.bytes_total = final.stat().st_size
            return final

        part = final.with_name(final.name + ".part")
        # Resume where a previous attempt stopped. Servers that ignore Range
        # answer 200 with the whole body, which is handled below by restarting
        # the file rather than appending to it.
        offset = part.stat().st_size if part.exists() else 0
        request = urllib.request.Request(target.url, headers={"User-Agent": DOWNLOAD_USER_AGENT})
        # A gated repo needs this to resolve at all; an ungated one ignores it.
        # huggingface_hub (used for the embedding model, below) reads the same
        # env vars, so one token covers both.
        hf_token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")
        if hf_token:
            request.add_header("Authorization", f"Bearer {hf_token}")
        if offset:
            request.add_header("Range", f"bytes={offset}-")
            log.info("Resuming %s at %d bytes", target.filename, offset)

        try:
            response = urllib.request.urlopen(request, timeout=SOCKET_TIMEOUT)
        except urllib.error.HTTPError as exc:
            # 416 = the range is past the end, i.e. the file is already whole.
            if exc.code == 416 and offset:
                part.replace(final)
                return final
            raise DownloadError(f"HTTP {exc.code} for {target.url}") from exc
        except urllib.error.URLError as exc:
            raise DownloadError(f"cannot reach {target.url}: {exc.reason}") from exc

        with response:
            resumed = response.status == 206
            if offset and not resumed:
                log.warning("%s ignored our Range header — restarting the file", target.url)
                offset = 0
            length = response.headers.get("Content-Length")
            total = (int(length) + offset) if length and length.isdigit() else None
            with self._lock:
                self._status.bytes_done = offset
                self._status.bytes_total = total

            mode = "ab" if offset else "wb"
            started = time.monotonic()
            done = offset
            with open(part, mode) as fh:
                while True:
                    if self._cancel.is_set():
                        log.info("Download of %s cancelled at %d bytes", target.filename, done)
                        return None
                    chunk = response.read(CHUNK)
                    if not chunk:
                        break
                    fh.write(chunk)
                    done += len(chunk)
                    elapsed = time.monotonic() - started
                    with self._lock:
                        self._status.bytes_done = done
                        if elapsed > 0:
                            self._status.bytes_per_second = (done - offset) / elapsed

        part.replace(final)
        log.info("Downloaded %s (%d bytes)", final, done)
        return final

    def _verify(self, path: Path, expected: str) -> None:
        log.info("Verifying SHA256 of %s", path)
        digest = hashlib.sha256()
        with open(path, "rb") as fh:
            for block in iter(lambda: fh.read(CHUNK), b""):
                digest.update(block)
        actual = digest.hexdigest()
        if actual.lower() != expected.strip().lower():
            # The file is corrupt; leaving it in place would make the next
            # download skip it as "already present" and load bad weights.
            path.unlink(missing_ok=True)
            raise DownloadError(f"SHA256 mismatch: expected {expected}, got {actual}")

    def _finish(self, state: str, *, error: str | None = None) -> None:
        with self._lock:
            self._status.state = state
            self._status.error = error
            self._status.finished_at = time.time()

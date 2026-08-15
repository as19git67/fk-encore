"""Fetching model files onto the volume.

Exercised against a real local HTTP server rather than a mocked urlopen: the
behaviour worth testing — resume via Range, a server that ignores Range,
checksum rejection — lives in the HTTP interaction itself.
"""

from __future__ import annotations

import hashlib
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from model_downloads import (
    DownloadError,
    DownloadManager,
    DownloadTarget,
    delete_model_file,
    disk_usage,
    filename_from_url,
    list_model_files,
    safe_filename,
)

PAYLOAD = bytes(range(256)) * 400  # 102_400 bytes, non-uniform so truncation shows


class _Handler(BaseHTTPRequestHandler):
    payload = PAYLOAD
    honour_range = True
    # Set to have every request answered with this status instead.
    fail_with: int | None = None
    seen_ranges: list[str | None] = []

    def do_GET(self):  # noqa: N802 — BaseHTTPRequestHandler's naming
        cls = type(self)
        cls.seen_ranges.append(self.headers.get("Range"))

        if cls.fail_with is not None:
            self.send_error(cls.fail_with)
            return

        start = 0
        rng = self.headers.get("Range")
        if rng and cls.honour_range:
            start = int(rng.removeprefix("bytes=").split("-")[0])
            if start >= len(cls.payload):
                self.send_error(416)
                return

        body = cls.payload[start:]
        self.send_response(206 if start else 200)
        self.send_header("Content-Length", str(len(body)))
        if start:
            self.send_header(
                "Content-Range", f"bytes {start}-{len(cls.payload) - 1}/{len(cls.payload)}"
            )
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):  # keep pytest output readable
        pass


@pytest.fixture
def http_server():
    _Handler.payload = PAYLOAD
    _Handler.honour_range = True
    _Handler.fail_with = None
    _Handler.seen_ranges = []

    server = HTTPServer(("127.0.0.1", 0), _Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_port}"
    server.shutdown()
    server.server_close()


def _wait_idle(manager: DownloadManager, timeout: float = 15.0) -> dict:
    deadline = time.monotonic() + timeout
    while manager.busy and time.monotonic() < deadline:
        time.sleep(0.02)
    assert not manager.busy, "download did not finish in time"
    return manager.status()


# ─── Name handling ─────────────────────────────────────────────────────────────


@pytest.mark.parametrize("name", ["../x.gguf", "a/b.gguf", "a\\b.gguf", "..", ".", "", "   "])
def test_names_that_could_escape_the_volume_are_rejected(name):
    with pytest.raises(DownloadError):
        safe_filename(name)


def test_a_dotfile_is_not_a_model_name():
    """.active_config.json lives in the same directory; a download must not be
    able to overwrite it."""

    with pytest.raises(DownloadError):
        safe_filename(".active_config.json")


def test_filename_comes_from_the_url_path_without_the_query():
    url = "https://host/repo/resolve/main/Model-Q4_K_M.gguf?download=true"
    assert filename_from_url(url) == "Model-Q4_K_M.gguf"


# ─── Listing ───────────────────────────────────────────────────────────────────


def test_listing_shows_models_largest_first_and_ignores_everything_else(tmp_path):
    (tmp_path / "small.gguf").write_bytes(b"x" * 10)
    (tmp_path / "big.gguf").write_bytes(b"x" * 100)
    (tmp_path / ".active_config.json").write_text("{}", encoding="utf-8")
    (tmp_path / "notes.txt").write_text("hi", encoding="utf-8")
    (tmp_path / "st-cache").mkdir()

    files = list_model_files(tmp_path)

    assert [f["filename"] for f in files] == ["big.gguf", "small.gguf"]
    assert files[0]["size_bytes"] == 100


def test_a_partial_download_is_listed_and_flagged(tmp_path):
    """"3 of 26 GB landed before the network dropped" is exactly what an
    operator looking at this list needs to see."""

    (tmp_path / "half.gguf.part").write_bytes(b"x" * 50)
    (files,) = (list_model_files(tmp_path),)
    assert files[0]["filename"] == "half.gguf.part"
    assert files[0]["partial"] is True


def test_listing_a_missing_directory_is_empty_not_an_error(tmp_path):
    assert list_model_files(tmp_path / "nope") == []


def test_disk_usage_of_a_missing_directory_is_nulls(tmp_path):
    assert disk_usage(tmp_path / "nope") == {"total_bytes": None, "free_bytes": None}


def test_delete_removes_the_file(tmp_path):
    (tmp_path / "gone.gguf").write_bytes(b"x")
    delete_model_file(tmp_path, "gone.gguf")
    assert not (tmp_path / "gone.gguf").exists()


def test_deleting_something_that_is_not_there_is_an_error(tmp_path):
    with pytest.raises(FileNotFoundError):
        delete_model_file(tmp_path, "absent.gguf")


# ─── Downloading ───────────────────────────────────────────────────────────────


def test_a_download_lands_the_whole_file(tmp_path, http_server):
    manager = DownloadManager(tmp_path)
    manager.start([DownloadTarget(url=f"{http_server}/m.gguf", filename="m.gguf")])
    status = _wait_idle(manager)

    assert status["state"] == "done"
    assert (tmp_path / "m.gguf").read_bytes() == PAYLOAD
    assert status["bytes_done"] == len(PAYLOAD)
    assert status["percent"] == 100.0
    assert status["completed"] == ["m.gguf"]
    # No .part left behind.
    assert [p.name for p in tmp_path.iterdir()] == ["m.gguf"]


def test_shards_are_fetched_as_one_job(tmp_path, http_server):
    manager = DownloadManager(tmp_path)
    manager.start(
        [
            DownloadTarget(url=f"{http_server}/a.gguf", filename="a.gguf"),
            DownloadTarget(url=f"{http_server}/b.gguf", filename="b.gguf"),
        ]
    )
    status = _wait_idle(manager)

    assert status["state"] == "done"
    assert status["completed"] == ["a.gguf", "b.gguf"]
    assert (tmp_path / "b.gguf").read_bytes() == PAYLOAD


def test_an_interrupted_download_resumes_where_it_stopped(tmp_path, http_server):
    """The reason .part files are kept on failure: re-fetching 26 GB because a
    router blinked is not an acceptable recovery."""

    (tmp_path / "m.gguf.part").write_bytes(PAYLOAD[:40_000])

    manager = DownloadManager(tmp_path)
    manager.start([DownloadTarget(url=f"{http_server}/m.gguf", filename="m.gguf")])
    _wait_idle(manager)

    assert _Handler.seen_ranges == ["bytes=40000-"]
    assert (tmp_path / "m.gguf").read_bytes() == PAYLOAD


def test_a_server_that_ignores_range_restarts_the_file(tmp_path, http_server):
    """Appending a full body onto a partial file would corrupt it silently."""

    _Handler.honour_range = False
    (tmp_path / "m.gguf.part").write_bytes(PAYLOAD[:40_000])

    manager = DownloadManager(tmp_path)
    manager.start([DownloadTarget(url=f"{http_server}/m.gguf", filename="m.gguf")])
    _wait_idle(manager)

    assert (tmp_path / "m.gguf").read_bytes() == PAYLOAD


def test_a_complete_part_file_is_promoted_rather_than_refetched(tmp_path, http_server):
    (tmp_path / "m.gguf.part").write_bytes(PAYLOAD)

    manager = DownloadManager(tmp_path)
    manager.start([DownloadTarget(url=f"{http_server}/m.gguf", filename="m.gguf")])
    _wait_idle(manager)

    assert (tmp_path / "m.gguf").read_bytes() == PAYLOAD


def test_an_existing_file_is_left_alone(tmp_path, http_server):
    (tmp_path / "m.gguf").write_bytes(b"already here")

    manager = DownloadManager(tmp_path)
    manager.start([DownloadTarget(url=f"{http_server}/m.gguf", filename="m.gguf")])
    _wait_idle(manager)

    assert (tmp_path / "m.gguf").read_bytes() == b"already here"
    assert _Handler.seen_ranges == []


def test_a_matching_checksum_passes(tmp_path, http_server):
    manager = DownloadManager(tmp_path)
    manager.start(
        [DownloadTarget(url=f"{http_server}/m.gguf", filename="m.gguf")],
        sha256=hashlib.sha256(PAYLOAD).hexdigest().upper(),  # case must not matter
    )
    assert _wait_idle(manager)["state"] == "done"


def test_a_corrupt_download_is_deleted_not_kept(tmp_path, http_server):
    """Left in place it would be skipped as "already present" next time, and
    the service would load broken weights."""

    manager = DownloadManager(tmp_path)
    manager.start(
        [DownloadTarget(url=f"{http_server}/m.gguf", filename="m.gguf")], sha256="00" * 32
    )
    status = _wait_idle(manager)

    assert status["state"] == "error"
    assert "SHA256 mismatch" in status["error"]
    assert not (tmp_path / "m.gguf").exists()


def test_an_http_error_is_reported_through_the_status(tmp_path, http_server):
    _Handler.fail_with = 404
    manager = DownloadManager(tmp_path)
    manager.start([DownloadTarget(url=f"{http_server}/m.gguf", filename="m.gguf")])
    status = _wait_idle(manager)

    assert status["state"] == "error"
    assert "404" in status["error"]


def test_an_unreachable_host_is_an_error_not_a_crash(tmp_path):
    manager = DownloadManager(tmp_path)
    # Port 1 on loopback refuses immediately, so this stays fast.
    manager.start([DownloadTarget(url="http://127.0.0.1:1/m.gguf", filename="m.gguf")])
    assert _wait_idle(manager)["state"] == "error"


def test_a_second_download_is_refused_while_one_runs(tmp_path, http_server):
    manager = DownloadManager(tmp_path)
    manager.start([DownloadTarget(url=f"{http_server}/m.gguf", filename="m.gguf")] * 40)
    try:
        with pytest.raises(DownloadError, match="already running"):
            manager.start([DownloadTarget(url=f"{http_server}/other.gguf", filename="o.gguf")])
    finally:
        manager.cancel()
        _wait_idle(manager)


def test_cancelling_keeps_the_partial_file_for_the_next_attempt(tmp_path, http_server):
    # A long shard list gives the cancel somewhere to land.
    targets = [
        DownloadTarget(url=f"{http_server}/s{i}.gguf", filename=f"s{i}.gguf") for i in range(60)
    ]
    manager = DownloadManager(tmp_path)
    manager.start(targets)
    manager.cancel()
    status = _wait_idle(manager)

    assert status["state"] == "cancelled"
    assert not any(p.name == "s59.gguf" for p in tmp_path.iterdir())


def test_cancelling_when_nothing_runs_reports_false(tmp_path):
    assert DownloadManager(tmp_path).cancel() is False


def test_a_non_http_url_is_rejected_before_anything_starts(tmp_path):
    manager = DownloadManager(tmp_path)
    with pytest.raises(DownloadError):
        manager.start([DownloadTarget(url="file:///etc/passwd", filename="m.gguf")])
    assert manager.status()["state"] == "idle"


def test_no_targets_is_an_error(tmp_path):
    with pytest.raises(DownloadError):
        DownloadManager(tmp_path).start([])


def test_run_blocking_raises_instead_of_reporting(tmp_path, http_server):
    """Startup has no one to poll a status endpoint, so a failed download has
    to abort the start."""

    _Handler.fail_with = 500
    with pytest.raises(DownloadError):
        DownloadManager(tmp_path).run_blocking(
            [DownloadTarget(url=f"{http_server}/m.gguf", filename="m.gguf")]
        )


def test_run_blocking_returns_once_the_file_is_there(tmp_path, http_server):
    DownloadManager(tmp_path).run_blocking(
        [DownloadTarget(url=f"{http_server}/m.gguf", filename="m.gguf")]
    )
    assert (tmp_path / "m.gguf").read_bytes() == PAYLOAD


def test_idle_status_is_serialisable_and_empty(tmp_path):
    status = DownloadManager(tmp_path).status()
    assert status["state"] == "idle"
    assert status["percent"] is None
    assert status["eta_seconds"] is None

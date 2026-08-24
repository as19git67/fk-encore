"""Cancelling discards the run; anything else leaves it resumable.

Both reach the script as SIGTERM, so the difference cannot be read off the
signal — it is carried by which path in the sidecar made the decision. These
pin that split, because getting it backwards either throws away paid-for work
or silently resumes a run the operator meant to stop.
"""

from __future__ import annotations

import asyncio
import signal

import pytest
from fastapi.testclient import TestClient

import main
from main import ToolName

TOOL = ToolName.cloud_audit
CHECKPOINT = main._CHECKPOINT_NAMES[TOOL]


@pytest.fixture
def out_dir(tmp_path, monkeypatch):
    d = tmp_path / "out"
    d.mkdir()
    monkeypatch.setattr(main, "SCRIPTS_DIR", str(tmp_path))
    for tool in ToolName:
        main._cancelled[tool] = False
        main._running[tool] = None
    return d


@pytest.fixture
def client():
    return TestClient(main.app)


def write_checkpoint(out_dir):
    (out_dir / f"{CHECKPOINT}.json").write_text('{"doc_ids": [1, 2]}', encoding="utf8")
    (out_dir / f"{CHECKPOINT}.jsonl").write_text('{"doc_id": 1}\n', encoding="utf8")


class FakeProcess:
    """Stands in for the script: records the signal, then exits."""

    def __init__(self, exit_after: float = 0.0):
        self.signals: list[int] = []
        self.killed = False
        self._exit_after = exit_after

    def send_signal(self, sig):
        self.signals.append(sig)

    def kill(self):
        self.killed = True

    async def wait(self):
        if self._exit_after:
            await asyncio.sleep(self._exit_after)
        return 0


def test_cancel_while_running_stops_it_and_drops_the_checkpoint(out_dir, client):
    write_checkpoint(out_dir)
    proc = FakeProcess()
    main._running[TOOL] = proc

    resp = client.post(f"/cancel/{TOOL.value}")

    assert resp.status_code == 200
    assert resp.json()["status"] == "cancelled"
    assert proc.signals == [signal.SIGTERM]
    assert main._cancelled[TOOL] is True
    assert not (out_dir / f"{CHECKPOINT}.json").exists()
    assert not (out_dir / f"{CHECKPOINT}.jsonl").exists()


def test_cancel_with_nothing_running_discards_a_pending_checkpoint(out_dir, client):
    """After a restart the run is gone but its progress is not — and cancelling
    is the operator saying they do not want the rest of it."""
    write_checkpoint(out_dir)

    resp = client.post(f"/cancel/{TOOL.value}")

    assert resp.status_code == 200
    assert resp.json()["status"] == "checkpoint-discarded"
    assert not (out_dir / f"{CHECKPOINT}.json").exists()


def test_cancel_with_nothing_to_cancel_is_a_404(out_dir, client):
    resp = client.post(f"/cancel/{TOOL.value}")
    assert resp.status_code == 404


def test_a_run_that_ignores_sigterm_is_killed(out_dir, client, monkeypatch):
    write_checkpoint(out_dir)
    monkeypatch.setattr(main, "_CANCEL_GRACE_SECONDS", 0.01)
    proc = FakeProcess(exit_after=5.0)
    main._running[TOOL] = proc

    resp = client.post(f"/cancel/{TOOL.value}")

    assert resp.status_code == 200
    assert proc.killed is True
    assert not (out_dir / f"{CHECKPOINT}.json").exists()


def test_a_restart_leaves_the_checkpoint_alone(out_dir, client):
    """A fresh sidecar process has no cancellation recorded, so the checkpoint
    it finds on the volume is there to be resumed."""
    write_checkpoint(out_dir)

    # What a restart looks like from here: in-memory state back to defaults.
    assert main._cancelled[TOOL] is False
    assert main._running[TOOL] is None

    assert main._has_checkpoint(TOOL) is True
    assert client.get("/health").json()["resumable"][TOOL.value] is True


def test_health_reports_no_resumable_run_once_it_is_cleared(out_dir, client):
    write_checkpoint(out_dir)
    main._clear_checkpoint(TOOL)
    assert client.get("/health").json()["resumable"][TOOL.value] is False


def test_tools_without_checkpoints_are_untouched_by_all_of_this(out_dir, client):
    for tool in (ToolName.diagnose, ToolName.scoreboard, ToolName.cloud_teacher):
        assert main._checkpoint_files(tool) == []
        assert main._has_checkpoint(tool) is False
        assert main._clear_checkpoint(tool) is False
    assert ToolName.diagnose.value not in client.get("/health").json()["resumable"]


def test_resume_false_is_passed_to_the_script(out_dir):
    env = main._build_env(TOOL, main.RunOptions(resume=False))
    assert env["AUDIT_RESUME"] == "0"


def test_resume_defaults_to_leaving_the_script_alone(out_dir):
    for opts in (main.RunOptions(), main.RunOptions(resume=True)):
        assert "AUDIT_RESUME" not in main._build_env(TOOL, opts)


def test_an_interrupted_run_keeps_its_progress_and_says_so(out_dir, client, monkeypatch):
    """The path a container stop takes: the script dies non-zero, nobody
    cancelled, and the checkpoint on the volume is left for the next start."""
    write_checkpoint(out_dir)
    monkeypatch.setattr(
        main, "_build_command",
        lambda tool, opts: ["python3", "-c", "import sys; sys.exit(143)"],
    )

    body = client.post(f"/run/{TOOL.value}", json={}).text

    assert "progress saved" in body
    assert "start again to continue" in body
    assert (out_dir / f"{CHECKPOINT}.json").exists()
    assert (out_dir / f"{CHECKPOINT}.jsonl").exists()


def test_a_run_that_finishes_cleanly_reports_done(out_dir, client, monkeypatch):
    monkeypatch.setattr(
        main, "_build_command",
        lambda tool, opts: ["python3", "-c", "print('fertig')"],
    )

    body = client.post(f"/run/{TOOL.value}", json={}).text

    assert "fertig" in body
    assert "exit 0" in body


def test_a_start_with_a_checkpoint_announces_the_resume(out_dir, client, monkeypatch):
    write_checkpoint(out_dir)
    monkeypatch.setattr(
        main, "_build_command",
        lambda tool, opts: ["python3", "-c", "pass"],
    )

    body = client.post(f"/run/{TOOL.value}", json={}).text

    assert "Resuming cloud-audit from checkpoint" in body

"""The "zurücksetzen" button for cloud-teacher labels.

The admin form sends a confidence threshold and/or document ids; the sidecar
turns them into a run of cloud_teacher_revert.py against the labels file of the
latest teacher run. These pin how the form maps onto that run and which labels
the script picks.
"""

from __future__ import annotations

import pytest
from fastapi import HTTPException

import main
import cloud_teacher_revert as revert


@pytest.fixture
def scripts_dir(tmp_path, monkeypatch):
    (tmp_path / "out").mkdir()
    monkeypatch.setattr(main, "SCRIPTS_DIR", str(tmp_path))
    return tmp_path


def _opts(**kw):
    return main.RunOptions(**kw)


def test_runs_against_the_latest_labels_file(scripts_dir):
    (scripts_dir / "out" / "2026-01-01-cloud_teacher_labels.json").write_text("[]")
    (scripts_dir / "out" / "2026-02-01-cloud_teacher_labels.json").write_text("[]")
    cmd = main._build_command(
        main.ToolName.cloud_teacher_revert,
        _opts(revert_below=0.65, revert_ids="11, 12 13", dry_run=True),
    )
    assert cmd[1].endswith("cloud_teacher_revert.py")
    assert cmd[2].endswith("2026-02-01-cloud_teacher_labels.json")
    assert cmd[3:] == ["--below=0.65", "--ids=11,12,13", "--dry-run"]


def test_without_a_teacher_run_there_is_nothing_to_revert(scripts_dir):
    with pytest.raises(HTTPException) as exc:
        main._build_command(main.ToolName.cloud_teacher_revert, _opts(revert_below=0.65))
    assert exc.value.status_code == 400


def test_needs_a_threshold_or_ids(scripts_dir):
    (scripts_dir / "out" / "2026-02-01-cloud_teacher_labels.json").write_text("[]")
    with pytest.raises(HTTPException):
        main._build_command(main.ToolName.cloud_teacher_revert, _opts(revert_ids=" , "))


def test_ids_reject_anything_but_digits():
    with pytest.raises(ValueError):
        _opts(revert_ids="1; DROP TABLE documents")


def test_picks_low_confidence_and_named_labels_that_were_written():
    entries = [
        {"doc_id": 1, "cloud_confidence": 0.5, "category_written": True},
        {"doc_id": 2, "cloud_confidence": 0.9, "category_written": True},
        {"doc_id": 3, "cloud_confidence": 0.9, "category_written": True},
        {"doc_id": 4, "cloud_confidence": 0.4, "category_written": False},
    ]
    picked = revert._select(entries, 0.65, {3})
    assert [e["doc_id"] for e in picked] == [1, 3]

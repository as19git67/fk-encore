"""Checkpoint round-trip for the long cloud runs.

A cloud-audit run costs real API money per document and takes long enough that
a container restart will eventually land in the middle of one. These pin the
guarantee that makes that survivable: every finished document is on disk, and a
half-written last line loses that one document rather than the whole run.
"""

from __future__ import annotations

import json

import pytest

import _common as c


@pytest.fixture
def out_dir(tmp_path, monkeypatch):
    """Point the checkpoint helpers at a throwaway out/ directory."""
    d = tmp_path / "out"
    d.mkdir()
    monkeypatch.setattr(c, "OUT_DIR", d)
    return d


def test_round_trip(out_dir):
    c.checkpoint_begin("run", {"fingerprint": "abc", "doc_ids": [1, 2, 3]})
    c.checkpoint_append("run", {"doc_id": 1, "claude_slug": "wohnen"})
    c.checkpoint_append("run", {"doc_id": 2, "claude_slug": "beruf"})

    meta, results = c.checkpoint_load("run")
    assert meta["fingerprint"] == "abc"
    assert meta["doc_ids"] == [1, 2, 3]
    assert [r["doc_id"] for r in results] == [1, 2]


def test_missing_checkpoint_reads_as_none(out_dir):
    assert c.checkpoint_load("run") is None


def test_begin_discards_an_earlier_run(out_dir):
    c.checkpoint_begin("run", {"fingerprint": "old", "doc_ids": [1]})
    c.checkpoint_append("run", {"doc_id": 1})
    c.checkpoint_begin("run", {"fingerprint": "new", "doc_ids": [2]})

    meta, results = c.checkpoint_load("run")
    assert meta["fingerprint"] == "new"
    assert results == []


def test_truncated_last_line_costs_only_that_document(out_dir):
    """The process can die mid-write — that must not void the whole run."""
    c.checkpoint_begin("run", {"fingerprint": "abc", "doc_ids": [1, 2, 3]})
    c.checkpoint_append("run", {"doc_id": 1})
    c.checkpoint_append("run", {"doc_id": 2})

    _, results_path = c.checkpoint_paths("run")
    complete = results_path.read_text(encoding="utf8")
    results_path.write_text(complete + '{"doc_id": 3, "claude_s', encoding="utf8")

    meta, results = c.checkpoint_load("run")
    assert [r["doc_id"] for r in results] == [1, 2]
    assert meta["doc_ids"] == [1, 2, 3]


def test_append_survives_a_missing_begin(out_dir):
    """Appending without a prior begin must not raise — it just has no meta."""
    c.checkpoint_append("run", {"doc_id": 1})
    assert c.checkpoint_load("run") is None  # no meta file, nothing to resume


def test_clear_is_idempotent(out_dir):
    c.checkpoint_begin("run", {"fingerprint": "abc", "doc_ids": [1]})
    c.checkpoint_append("run", {"doc_id": 1})

    c.checkpoint_clear("run")
    c.checkpoint_clear("run")  # second call must not raise

    assert c.checkpoint_load("run") is None
    for path in c.checkpoint_paths("run"):
        assert not path.exists()


def test_results_are_one_json_object_per_line(out_dir):
    """The reader tolerates a bad last line only if good lines stay parseable."""
    c.checkpoint_begin("run", {"fingerprint": "abc", "doc_ids": [1, 2]})
    c.checkpoint_append("run", {"doc_id": 1, "reasoning": "mehrzeilig\nmit Umbruch"})
    c.checkpoint_append("run", {"doc_id": 2, "reasoning": "Anführungszeichen \" drin"})

    _, results_path = c.checkpoint_paths("run")
    lines = results_path.read_text(encoding="utf8").splitlines()
    assert len(lines) == 2
    assert [json.loads(line)["doc_id"] for line in lines] == [1, 2]

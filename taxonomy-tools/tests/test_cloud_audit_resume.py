"""Which runs may continue an earlier one, and which must start over.

Resuming is only safe when the stored results answer the same question the new
run is asking. The sample is drawn with ORDER BY random(), so a resume that
re-drew it would mix judgements about one set of documents into a report about
another.
"""

from __future__ import annotations

import pytest

import _common as c
import cloud_audit as ca


@pytest.fixture
def out_dir(tmp_path, monkeypatch):
    d = tmp_path / "out"
    d.mkdir()
    monkeypatch.setattr(c, "OUT_DIR", d)
    return d


@pytest.fixture
def no_db(monkeypatch):
    """Replace both DB paths so the decision logic can be tested on its own."""
    sampled = [{"id": 10}, {"id": 11}, {"id": 12}]
    monkeypatch.setattr(ca, "_sample_documents", lambda conn: list(sampled))
    monkeypatch.setattr(
        ca, "_fetch_documents_by_ids",
        lambda conn, ids: [{"id": i} for i in ids],
    )
    return sampled


def test_fingerprint_tracks_the_parameters_that_shape_the_sample(monkeypatch):
    base = ca._run_fingerprint()
    assert ca._run_fingerprint() == base  # stable for unchanged parameters

    monkeypatch.setattr(ca, "SAMPLE_SIZE", ca.SAMPLE_SIZE + 1)
    assert ca._run_fingerprint() != base


def test_fingerprint_changes_with_the_model(monkeypatch):
    base = ca._run_fingerprint()
    monkeypatch.setattr(ca, "CLAUDE_MODEL", ca.CLAUDE_MODEL + "-other")
    assert ca._run_fingerprint() != base


def test_fingerprint_ignores_focus_section_order(monkeypatch):
    monkeypatch.setattr(ca, "TAX_FOCUS_SECTIONS", ["anlage-n", "anlage-kind"])
    one = ca._run_fingerprint()
    monkeypatch.setattr(ca, "TAX_FOCUS_SECTIONS", ["anlage-kind", "anlage-n"])
    assert ca._run_fingerprint() == one


def test_fresh_run_writes_a_checkpoint_covering_the_sample(out_dir, no_db):
    done, remaining, resumed = ca._resume_or_sample(conn=None)

    assert resumed is False
    assert done == []
    assert [d["id"] for d in remaining] == [10, 11, 12]

    meta, results = c.checkpoint_load(ca.CHECKPOINT_NAME)
    assert meta["doc_ids"] == [10, 11, 12]
    assert meta["fingerprint"] == ca._run_fingerprint()
    assert results == []


def test_resume_skips_the_documents_already_classified(out_dir, no_db):
    c.checkpoint_begin(ca.CHECKPOINT_NAME, {
        "fingerprint": ca._run_fingerprint(),
        "doc_ids": [10, 11, 12],
    })
    c.checkpoint_append(ca.CHECKPOINT_NAME, {"doc_id": 10, "claude_slug": "wohnen"})

    done, remaining, resumed = ca._resume_or_sample(conn=None)

    assert resumed is True
    assert [r["doc_id"] for r in done] == [10]
    assert [d["id"] for d in remaining] == [11, 12]


def test_error_rows_count_as_done_and_are_not_retried(out_dir, no_db):
    """An ERROR row is a document Claude was asked about and could not answer.

    It is recorded so the report can name the failure; re-asking on every resume
    would pay for the same failure again.
    """
    c.checkpoint_begin(ca.CHECKPOINT_NAME, {
        "fingerprint": ca._run_fingerprint(),
        "doc_ids": [10, 11, 12],
    })
    c.checkpoint_append(ca.CHECKPOINT_NAME, {"doc_id": 10, "claude_slug": "ERROR"})

    done, remaining, _ = ca._resume_or_sample(conn=None)

    assert [r["doc_id"] for r in done] == [10]
    assert [d["id"] for d in remaining] == [11, 12]


def test_changed_parameters_start_over(out_dir, no_db):
    c.checkpoint_begin(ca.CHECKPOINT_NAME, {
        "fingerprint": "belongs-to-a-different-run",
        "doc_ids": [1, 2, 3],
    })
    c.checkpoint_append(ca.CHECKPOINT_NAME, {"doc_id": 1})

    done, remaining, resumed = ca._resume_or_sample(conn=None)

    assert resumed is False
    assert done == []
    assert [d["id"] for d in remaining] == [10, 11, 12]
    # and the stale results are gone rather than lingering for the next run
    meta, results = c.checkpoint_load(ca.CHECKPOINT_NAME)
    assert meta["doc_ids"] == [10, 11, 12]
    assert results == []


def test_resume_disabled_draws_a_fresh_sample(out_dir, no_db, monkeypatch):
    c.checkpoint_begin(ca.CHECKPOINT_NAME, {
        "fingerprint": ca._run_fingerprint(),
        "doc_ids": [1, 2, 3],
    })
    c.checkpoint_append(ca.CHECKPOINT_NAME, {"doc_id": 1})
    monkeypatch.setattr(ca, "RESUME_ENABLED", False)

    done, remaining, resumed = ca._resume_or_sample(conn=None)

    assert resumed is False
    assert done == []
    assert [d["id"] for d in remaining] == [10, 11, 12]


def test_documents_deleted_since_the_run_started_drop_out(out_dir, monkeypatch):
    monkeypatch.setattr(ca, "_sample_documents", lambda conn: [])
    # Document 11 no longer exists, so the re-read returns only 10 and 12.
    monkeypatch.setattr(
        ca, "_fetch_documents_by_ids",
        lambda conn, ids: [{"id": i} for i in ids if i != 11],
    )
    c.checkpoint_begin(ca.CHECKPOINT_NAME, {
        "fingerprint": ca._run_fingerprint(),
        "doc_ids": [10, 11, 12],
    })

    done, remaining, resumed = ca._resume_or_sample(conn=None)

    assert resumed is True
    assert done == []
    assert [d["id"] for d in remaining] == [10, 12]


def test_a_checkpoint_without_a_sample_is_not_resumed(out_dir, no_db):
    """Without the stored ids there is nothing to line the results up against."""
    c.checkpoint_begin(ca.CHECKPOINT_NAME, {
        "fingerprint": ca._run_fingerprint(),
        "doc_ids": [],
    })

    done, remaining, resumed = ca._resume_or_sample(conn=None)

    assert resumed is False
    assert [d["id"] for d in remaining] == [10, 11, 12]

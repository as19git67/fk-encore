"""Tests for the Bezugspersonen (subject persons) plumbing in the
``/classify`` handler — covers the Pydantic schema and the outline that is
spliced into the user prompt when the caller supplies a non-empty
``subject_persons`` list.

The system-prompt *text* for this feature no longer lives in main.py — it is
pushed from the Encore app via ``PUT /prompts`` (see
``documents/classify-prompts.ts`` and `test_prompts_endpoint.py`), so it is
no longer a module-level constant to sanity-check here.
"""

from __future__ import annotations

import os
import sys

import pytest
from pydantic import ValidationError

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from main import (  # noqa: E402
    ClassifyRequest,
    SubjectPersonEntry,
    TaxonomyNode,
    _subject_persons_outline,
)


class TestSubjectPersonEntry:
    def test_accepts_name_and_tag(self):
        e = SubjectPersonEntry(full_name="Erika Mustermann", relation_tag="mutter")
        assert e.full_name == "Erika Mustermann"
        assert e.relation_tag == "mutter"

    def test_rejects_missing_fields(self):
        with pytest.raises(ValidationError):
            SubjectPersonEntry(full_name="Erika Mustermann")  # type: ignore[call-arg]

    def test_household_attributes_default_to_unset(self):
        e = SubjectPersonEntry(full_name="Erika Mustermann", relation_tag="mutter")
        assert e.relation_kind == ""
        assert e.tax_cost_bearer == ""
        assert e.in_household is None

    def test_accepts_household_attributes(self):
        e = SubjectPersonEntry(
            full_name="Max Mustermann",
            relation_tag="ehepartner",
            relation_kind="spouse",
            tax_cost_bearer="user",
            in_household=True,
        )
        assert e.relation_kind == "spouse"
        assert e.tax_cost_bearer == "user"
        assert e.in_household is True


class TestSubjectPersonsOutline:
    def test_empty_input_yields_empty_string(self):
        assert _subject_persons_outline([]) == ""

    def test_renders_one_line_per_entry(self):
        entries = [
            SubjectPersonEntry(full_name="Erika Mustermann", relation_tag="mutter"),
            SubjectPersonEntry(full_name="Hans Mustermann", relation_tag="vater"),
        ]
        rendered = _subject_persons_outline(entries)
        assert "Erika Mustermann → mutter" in rendered
        assert "Hans Mustermann → vater" in rendered
        assert rendered.count("\n") == 1

    def test_omits_household_attributes_when_unset(self):
        """Callers that only send name + tag must render exactly as before."""
        entries = [SubjectPersonEntry(full_name="Erika Mustermann", relation_tag="mutter")]
        assert _subject_persons_outline(entries) == "- Erika Mustermann → mutter"

    def test_renders_household_attributes_when_present(self):
        entries = [
            SubjectPersonEntry(
                full_name="Max Mustermann",
                relation_tag="ehepartner",
                relation_kind="spouse",
                tax_cost_bearer="user",
                in_household=True,
            ),
        ]
        rendered = _subject_persons_outline(entries)
        assert "relation_kind=spouse" in rendered
        assert "tax_cost_bearer=user" in rendered
        assert "in_household=ja" in rendered

    def test_renders_in_household_false_as_nein(self):
        entries = [
            SubjectPersonEntry(
                full_name="Erika Mustermann",
                relation_tag="mutter",
                relation_kind="parent",
                in_household=False,
            ),
        ]
        rendered = _subject_persons_outline(entries)
        assert "in_household=nein" in rendered
        # Unset attributes stay out of the line entirely.
        assert "tax_cost_bearer" not in rendered


class TestClassifyRequestSubjectPersons:
    def test_defaults_to_empty_list(self):
        req = ClassifyRequest(
            text="hello",
            taxonomy=[TaxonomyNode(slug="x", name="X", parent_slug=None)],
        )
        assert req.subject_persons == []

    def test_accepts_subject_persons(self):
        req = ClassifyRequest(
            text="hello",
            taxonomy=[TaxonomyNode(slug="x", name="X", parent_slug=None)],
            subject_persons=[
                SubjectPersonEntry(full_name="Erika Mustermann", relation_tag="mutter"),
            ],
        )
        assert len(req.subject_persons) == 1
        assert req.subject_persons[0].relation_tag == "mutter"


class TestClassifyRequestAssessmentType:
    def test_defaults_to_empty(self):
        req = ClassifyRequest(
            text="hello",
            taxonomy=[TaxonomyNode(slug="x", name="X", parent_slug=None)],
        )
        assert req.assessment_type == ""

    def test_accepts_assessment_type(self):
        req = ClassifyRequest(
            text="hello",
            taxonomy=[TaxonomyNode(slug="x", name="X", parent_slug=None)],
            assessment_type="zusammen",
        )
        assert req.assessment_type == "zusammen"

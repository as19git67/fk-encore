"""The benchmark's scorer and its case file — the numbers in the plan are
only as good as these two."""

from __future__ import annotations

import json

import pytest

import chat
from bench.chat_bench import DEFAULT_CASES, matches, run_case, score_case

SUITE = json.loads(DEFAULT_CASES.read_text(encoding="utf-8"))


@pytest.mark.parametrize(
    "expected, actual, ok",
    [
        ("2026-10-31", "2026-10-31", True),
        ("2026-10-31", "2026-10-30", False),
        (2025, "2025", True),
        (True, True, True),
        (True, None, False),
        ("trip", " Trip ", True),
        ({"$contains": "eigentümerversammlung"}, "Protokoll Eigentümerversammlung", True),
        ({"$contains": "x"}, None, False),
        ({"$in": ["a", "b"]}, "B", True),
        ({"$present": True}, "", False),
        ({"$absent": True}, None, True),
    ],
)
def test_matches(expected, actual, ok):
    assert matches(expected, actual) is ok


def test_score_needs_every_expected_call_and_an_answer():
    case = {"expect": [{"tool": "list_photos", "args": {"favorite": True}},
                       {"tool": "create_album", "args": {"name": {"$present": True}}}]}
    good = [{"tool": "list_photos", "args": {"favorite": True}}, {"tool": "create_album", "args": {"name": "F"}}]

    assert score_case(case, good, answered=True).passed
    assert not score_case(case, good, answered=False).passed
    wrong_args = score_case(case, [good[0] | {"args": {}}, good[1]], answered=True)
    assert wrong_args.tool_hit and not wrong_args.args_hit and wrong_args.missing == ["list_photos"]


def test_forbid_tools_fails_on_any_call():
    case = {"expect": [], "forbid_tools": True}
    assert score_case(case, [], answered=True).passed
    assert not score_case(case, [{"tool": "list_accounts", "args": {}}], answered=True).passed


def test_case_file_is_consistent():
    """Every expected tool exists, every canned result belongs to a tool, the
    tool list is a valid /chat request, and the ids are unique."""

    names = {t["function"]["name"] for t in SUITE["tools"]}
    chat.ChatRequest(messages=[{"role": "user", "content": "x"}], tools=SUITE["tools"])
    ids = [c["id"] for c in SUITE["cases"]]
    assert len(ids) == len(set(ids))
    assert len(ids) >= 14
    for case in SUITE["cases"]:
        for e in case["expect"]:
            assert e["tool"] in names, (case["id"], e["tool"])
        for tool in case["results"]:
            assert tool in names, (case["id"], tool)


def test_run_case_loops_through_tool_results(monkeypatch):
    case = next(c for c in SUITE["cases"] if c["id"] == "electricity-last-year")
    replies = iter([
        {"message": {"role": "assistant", "content": None, "tool_calls": [
            {"id": "a", "type": "function", "function": {"name": "list_meters", "arguments": "{}"}}]}},
        {"message": {"role": "assistant", "content": None, "tool_calls": [
            {"id": "b", "type": "function", "function": {"name": "consumption_report",
             "arguments": '{"meter_id": "m-strom", "from": "2025-01-01", "to": "2025-12-31"}'}}]}},
        {"message": {"role": "assistant", "content": "3412 kWh."}},
    ])
    sent: list[dict] = []

    def fake_post(url, secret, body, timeout):
        sent.append(json.loads(json.dumps(body)))
        return next(replies)

    monkeypatch.setattr("bench.chat_bench.post_chat", fake_post)
    run = run_case(case, SUITE, url="http://x", secret="s", max_rounds=6, max_tokens=100, timeout=1)

    assert run.score.passed and run.answer == "3412 kWh." and len(run.rounds) == 3
    # The second request carries the first call and its canned result.
    tool_msg = sent[1]["messages"][-1]
    assert tool_msg["role"] == "tool" and tool_msg["tool_call_id"] == "a"
    assert "m-strom" in tool_msg["content"]

"""Tool-use benchmark for ``POST /chat`` (ki-assistent.md, stage 1).

Runs every case of ``chat_cases.json`` as a small agent loop against a live
llm-service: the question goes in with the full tool list, each tool call is
answered from the case's canned results, and the loop ends on an answer or
after ``--max-rounds``. Scored on "right tool, right arguments" and timed per
round, which is what decides how many rounds the assistant may spend on one
question.

Usage (from ``llm-service/``):

    INTERNAL_SERVICE_SECRET=... python bench/chat_bench.py --url http://localhost:8001
    python bench/chat_bench.py --url ... --only trips-last-year --verbose
    python bench/chat_bench.py --url ... --json out.json

Stdlib only, so it runs from any host that can reach the service. The cases
use synthetic data and a fixed "today" so the expected dates do not drift.
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import time
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

DEFAULT_CASES = Path(__file__).with_name("chat_cases.json")


# ─── scoring ───────────────────────────────────────────────────────────────────


def _loose(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value).strip().casefold()


def matches(expected: Any, actual: Any) -> bool:
    """One argument against its expectation.

    A literal compares loosely (case, whitespace, ``2025`` vs ``"2025"``);
    ``{"$contains": s}``, ``{"$in": [...]}``, ``{"$present": true}`` and
    ``{"$absent": true}`` cover what a literal cannot.
    """

    if isinstance(expected, dict) and len(expected) == 1:
        (op, operand), = expected.items()
        if op == "$present":
            return actual is not None and actual != ""
        if op == "$absent":
            return actual is None
        if op == "$contains":
            return actual is not None and _loose(operand) in _loose(actual)
        if op == "$in":
            return actual is not None and _loose(actual) in {_loose(o) for o in operand}
    if actual is None:
        return False
    return _loose(expected) == _loose(actual)


def call_matches(expect: dict[str, Any], call: dict[str, Any]) -> bool:
    if call["tool"] != expect["tool"]:
        return False
    args = call.get("args") or {}
    return all(matches(want, args.get(key)) for key, want in (expect.get("args") or {}).items())


@dataclass
class CaseScore:
    tool_hit: bool
    args_hit: bool
    answered: bool
    passed: bool
    missing: list[str] = field(default_factory=list)


def score_case(case: dict[str, Any], calls: list[dict[str, Any]], answered: bool) -> CaseScore:
    """Every expected call must occur somewhere in the run, in any order.

    Order is free on purpose: a model that lists the categories first and
    one that searches straight away both reach the right documents. Extra
    read calls are not penalised; ``forbid_tools`` cases fail on any call.
    """

    if case.get("forbid_tools") and calls:
        return CaseScore(False, False, answered, False, ["no tool call expected"])
    called = {c["tool"] for c in calls}
    expects = case.get("expect") or []
    tool_hit = all(e["tool"] in called for e in expects)
    missing = [e["tool"] for e in expects if not any(call_matches(e, c) for c in calls)]
    args_hit = not missing
    return CaseScore(tool_hit, args_hit, answered, tool_hit and args_hit and answered, missing)


# ─── running ───────────────────────────────────────────────────────────────────


@dataclass
class Round:
    millis: int
    processing_ms: int | None
    calls: list[dict[str, Any]]
    prompt_tokens: int | None


@dataclass
class CaseRun:
    id: str
    rounds: list[Round]
    calls: list[dict[str, Any]]
    answer: str | None
    error: str | None
    score: CaseScore


def post_chat(url: str, secret: str, body: dict[str, Any], timeout: float) -> dict[str, Any]:
    req = urllib.request.Request(
        f"{url.rstrip('/')}/chat",
        data=json.dumps(body).encode("utf-8"),
        method="POST",
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {secret}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"HTTP {exc.code}: {exc.read().decode('utf-8', errors='replace')[:300]}") from exc


def run_case(case: dict[str, Any], suite: dict[str, Any], *, url: str, secret: str,
             max_rounds: int, max_tokens: int, timeout: float) -> CaseRun:
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": suite["system"]},
        {"role": "user", "content": case["question"]},
    ]
    rounds: list[Round] = []
    calls: list[dict[str, Any]] = []
    answer: str | None = None
    error: str | None = None

    for _ in range(max_rounds):
        t0 = time.monotonic()
        try:
            reply = post_chat(url, secret, {
                "messages": messages, "tools": suite["tools"],
                "max_tokens": max_tokens, "temperature": 0.0,
            }, timeout)
        except Exception as exc:  # noqa: BLE001 — a failed round is a result
            error = str(exc)
            break
        millis = int((time.monotonic() - t0) * 1000)
        message = reply["message"]
        round_calls = [
            {"tool": c["function"]["name"], "args": json.loads(c["function"]["arguments"] or "{}")}
            for c in message.get("tool_calls") or []
        ]
        usage = reply.get("usage") or {}
        rounds.append(Round(millis, reply.get("processing_ms"), round_calls, usage.get("prompt_tokens")))
        if not round_calls:
            answer = message.get("content")
            break
        calls.extend(round_calls)
        messages.append(message)
        for raw, call in zip(message["tool_calls"], round_calls):
            result = case.get("results", {}).get(call["tool"], {"error": "no data for this tool in the benchmark"})
            messages.append({"role": "tool", "tool_call_id": raw["id"], "content": json.dumps(result, ensure_ascii=False)})

    score = score_case(case, calls, answered=answer is not None)
    return CaseRun(case["id"], rounds, calls, answer, error, score)


def summarize(runs: list[CaseRun]) -> dict[str, Any]:
    n = len(runs) or 1
    round_ms = [r.millis for run in runs for r in run.rounds]
    rounds_per_case = [len(run.rounds) for run in runs if run.rounds]
    return {
        "cases": len(runs),
        "passed": sum(r.score.passed for r in runs),
        "tool_hit_rate": sum(r.score.tool_hit for r in runs) / n,
        "args_hit_rate": sum(r.score.args_hit for r in runs) / n,
        "pass_rate": sum(r.score.passed for r in runs) / n,
        "errors": sum(r.error is not None for r in runs),
        "rounds": len(round_ms),
        "median_ms_per_round": statistics.median(round_ms) if round_ms else None,
        "p90_ms_per_round": (sorted(round_ms)[int(0.9 * (len(round_ms) - 1))] if round_ms else None),
        "median_rounds_per_case": statistics.median(rounds_per_case) if rounds_per_case else None,
        "max_rounds_used": max(rounds_per_case) if rounds_per_case else None,
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--url", default=os.environ.get("LLM_SERVICE_URL", "http://localhost:8001"))
    ap.add_argument("--cases", type=Path, default=DEFAULT_CASES)
    ap.add_argument("--only", action="append", help="case id; repeatable")
    ap.add_argument("--max-rounds", type=int, default=6)
    ap.add_argument("--max-tokens", type=int, default=768)
    ap.add_argument("--timeout", type=float, default=300.0)
    ap.add_argument("--json", type=Path, help="write raw runs and summary here")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args(argv)

    secret = os.environ.get("INTERNAL_SERVICE_SECRET", "").strip()
    if not secret:
        print("INTERNAL_SERVICE_SECRET is not set", file=sys.stderr)
        return 2

    suite = json.loads(args.cases.read_text(encoding="utf-8"))
    cases = [c for c in suite["cases"] if not args.only or c["id"] in args.only]
    runs: list[CaseRun] = []
    for case in cases:
        run = run_case(case, suite, url=args.url, secret=secret, max_rounds=args.max_rounds,
                       max_tokens=args.max_tokens, timeout=args.timeout)
        runs.append(run)
        mark = "PASS" if run.score.passed else "FAIL"
        trail = " → ".join(f"{c['tool']}({json.dumps(c['args'], ensure_ascii=False)})" for c in run.calls) or "—"
        times = "/".join(str(r.millis) for r in run.rounds)
        print(f"{mark} {run.id:28} {len(run.rounds)} round(s) [{times} ms] {trail}")
        if run.error:
            print(f"     error: {run.error}")
        elif not run.score.passed and run.score.missing:
            print(f"     missing: {', '.join(run.score.missing)}")
        if args.verbose and run.answer:
            print(f"     answer: {run.answer}")

    summary = summarize(runs)
    print()
    print(
        f"{summary['passed']}/{summary['cases']} passed · tool {summary['tool_hit_rate']:.0%} · "
        f"args {summary['args_hit_rate']:.0%} · median {summary['median_ms_per_round']} ms/round "
        f"(p90 {summary['p90_ms_per_round']}) · median {summary['median_rounds_per_case']} rounds, "
        f"max {summary['max_rounds_used']}"
    )
    if args.json:
        args.json.write_text(json.dumps(
            {"summary": summary, "runs": [asdict(r) for r in runs]}, ensure_ascii=False, indent=1,
        ), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())

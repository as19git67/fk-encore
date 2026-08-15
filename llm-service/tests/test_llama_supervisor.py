"""llama-server argument construction and subprocess ownership.

The argument tests matter because this command line replaces the one
entrypoint.sh used to assemble: a flag lost in the move would silently change
how every deployment runs its model.
"""

from __future__ import annotations

import sys
import textwrap
import threading
import time
from pathlib import Path

import pytest

from llama_supervisor import LlamaServerProcess, build_args, server_port
from llm_config import LlmConfig


def _cfg(**overrides) -> LlmConfig:
    return LlmConfig.from_dict(
        {"model_filename": "model.gguf", "backend": "server", **overrides},
        models_dir=Path("/models"),
    )


def _pairs(args: list[str]) -> dict[str, str]:
    return {a: b for a, b in zip(args, args[1:]) if a.startswith("--")}


# ─── Argument construction ─────────────────────────────────────────────────────


def test_the_defaults_match_what_entrypoint_used_to_pass():
    args = build_args(_cfg())
    pairs = _pairs(args)

    assert pairs["--model"] == "/models/model.gguf"
    assert pairs["--host"] == "127.0.0.1"
    assert pairs["--port"] == "8080"
    assert pairs["--ctx-size"] == "8192"
    assert pairs["--batch-size"] == "512"
    assert pairs["--ubatch-size"] == "512"
    assert pairs["--n-gpu-layers"] == "0"
    assert pairs["--cache-type-k"] == "f16"
    assert pairs["--cache-type-v"] == "f16"
    assert pairs["--flash-attn"] == "off"
    assert pairs["--reasoning"] == "off"
    # Both are bare flags, so they carry no value to compare.
    assert "--jinja" in args
    assert "--no-webui" in args


def test_expert_offload_is_passed_only_when_asked_for():
    """0 is a no-op and correct for a dense model — passing it anyway would
    make the flag look meaningful in the process list."""

    assert "--n-cpu-moe" not in build_args(_cfg(n_cpu_moe=0))
    assert _pairs(build_args(_cfg(n_cpu_moe=32)))["--n-cpu-moe"] == "32"


def test_threads_are_omitted_when_unset():
    """`--threads ''` is not a thing; 0 means let llama.cpp decide."""

    assert "--threads" not in build_args(_cfg(threads=None))
    assert _pairs(build_args(_cfg(threads=12)))["--threads"] == "12"


def test_flash_attention_is_a_switch_not_a_presence_flag():
    assert _pairs(build_args(_cfg(flash_attn=True)))["--flash-attn"] == "on"
    assert _pairs(build_args(_cfg(flash_attn=False)))["--flash-attn"] == "off"


def test_kv_type_applies_to_both_halves_of_the_cache():
    pairs = _pairs(build_args(_cfg(kv_type="q8_0", flash_attn=True)))
    assert pairs["--cache-type-k"] == "q8_0"
    assert pairs["--cache-type-v"] == "q8_0"


def test_extra_args_are_word_split_and_appended():
    args = build_args(_cfg(server_extra_args="--override-tensor exps=CPU --mlock"))
    assert args[-3:] == ["--override-tensor", "exps=CPU", "--mlock"]


def test_blank_extra_args_add_nothing():
    assert build_args(_cfg(server_extra_args="   ")) == build_args(_cfg())


def test_the_port_comes_from_the_url_the_app_will_call():
    """One source of truth for both ends of the loopback connection."""

    assert server_port("http://127.0.0.1:9001") == 9001
    assert _pairs(build_args(_cfg(server_url="http://127.0.0.1:9001")))["--port"] == "9001"


def test_a_url_without_a_port_is_an_error():
    with pytest.raises(ValueError):
        server_port("http://127.0.0.1")


# ─── Process ownership ─────────────────────────────────────────────────────────


@pytest.fixture
def fake_server(tmp_path):
    """A stand-in binary that sleeps until killed, or exits with a given code.

    Real llama-server is not available in CI, and what needs testing here is
    the supervision — start, deliberate stop, crash detection — not llama.cpp.
    """

    script = tmp_path / "fake-llama-server"
    script.write_text(
        textwrap.dedent(
            """
            import sys, time
            # A --port value of 1 is our signal to exit immediately.
            if "1" == sys.argv[sys.argv.index("--port") + 1]:
                sys.exit(3)
            time.sleep(300)
            """
        ),
        encoding="utf-8",
    )
    launcher = tmp_path / "llama-server"
    launcher.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{script}" "$@"\n', encoding="utf-8")
    launcher.chmod(0o755)
    return launcher


def test_a_missing_binary_is_reported_not_guessed(tmp_path):
    proc = LlamaServerProcess(binary=str(tmp_path / "nope"))
    assert proc.available is False
    with pytest.raises(FileNotFoundError):
        proc.start(_cfg())


def test_start_then_stop(fake_server):
    proc = LlamaServerProcess(binary=str(fake_server))
    assert proc.available is True

    proc.start(_cfg())
    assert proc.is_running is True

    proc.stop(timeout=10)
    assert proc.is_running is False


def test_starting_twice_is_refused(fake_server):
    proc = LlamaServerProcess(binary=str(fake_server))
    proc.start(_cfg())
    try:
        with pytest.raises(RuntimeError):
            proc.start(_cfg())
    finally:
        proc.stop(timeout=10)


def test_a_deliberate_stop_is_not_reported_as_a_crash(fake_server):
    """Otherwise every model swap would take the container down with it."""

    called = threading.Event()
    proc = LlamaServerProcess(binary=str(fake_server), on_unexpected_exit=lambda _s: called.set())

    proc.start(_cfg())
    proc.stop(timeout=10)

    assert called.wait(timeout=2) is False


def test_a_crash_is_reported(fake_server):
    """This callback is what preserves entrypoint.sh's `wait -n` behaviour:
    a llama-server that dies takes the service down rather than leaving it
    answering 503 forever."""

    seen: list[int] = []
    done = threading.Event()

    def on_exit(status: int) -> None:
        seen.append(status)
        done.set()

    proc = LlamaServerProcess(binary=str(fake_server), on_unexpected_exit=on_exit)
    proc.start(_cfg(server_url="http://127.0.0.1:1"))

    assert done.wait(timeout=10) is True
    assert seen == [3]
    assert proc.is_running is False


def test_stop_is_a_no_op_when_nothing_is_running(fake_server):
    LlamaServerProcess(binary=str(fake_server)).stop(timeout=1)


def test_stop_after_a_crash_does_not_hang(fake_server):
    proc = LlamaServerProcess(binary=str(fake_server))
    proc.start(_cfg(server_url="http://127.0.0.1:1"))
    deadline = time.monotonic() + 10
    while proc.is_running and time.monotonic() < deadline:
        time.sleep(0.05)
    proc.stop(timeout=5)
    assert proc.is_running is False

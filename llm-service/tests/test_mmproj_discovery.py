"""Finding the multimodal projector by convention rather than configuration.

The projector is just another file next to the weights, so it belongs in
`extra_urls` with them. A configured path is a second thing to keep in sync
with the download, and the two drift — a configuration switched to a different
model keeps pointing at the old model's projector, and that failure is a wrong
answer rather than an error.
"""

from pathlib import Path

from llm_config import LlmConfig, discover_mmproj


def touch(directory: Path, *names: str) -> None:
    for name in names:
        (directory / name).write_bytes(b"")


MODEL = "gemma-4-26B-A4B-it-qat-UD-Q4_K_XL.gguf"


def test_no_projector_on_the_volume(tmp_path: Path) -> None:
    touch(tmp_path, MODEL)
    assert discover_mmproj(tmp_path, MODEL) == ""


def test_finds_the_only_projector(tmp_path: Path) -> None:
    touch(tmp_path, MODEL, "mmproj-gemma-4-26B-A4B-it-qat-F16.gguf")
    assert discover_mmproj(tmp_path, MODEL).endswith(
        "mmproj-gemma-4-26B-A4B-it-qat-F16.gguf"
    )


def test_picks_the_projector_belonging_to_this_model(tmp_path: Path) -> None:
    # One volume, several models. A wrong projector is worse than none: the
    # server starts, answers, and is quietly wrong about every image.
    touch(
        tmp_path,
        MODEL,
        "mmproj-qwen3-8b-F16.gguf",
        "mmproj-gemma-4-26B-A4B-it-qat-F16.gguf",
    )
    assert "gemma" in discover_mmproj(tmp_path, MODEL)


def test_ignores_a_download_still_in_flight(tmp_path: Path) -> None:
    # `.part` is what the downloader leaves behind mid-transfer. Handing that
    # to llama-server would fail the start rather than degrade to text-only.
    touch(tmp_path, MODEL, "mmproj-gemma-4-26B-A4B-it-qat-F16.gguf.part")
    assert discover_mmproj(tmp_path, MODEL) == ""


def test_missing_volume_reads_as_text_only(tmp_path: Path) -> None:
    assert discover_mmproj(tmp_path / "nope", MODEL) == ""


def config(tmp_path: Path, **kw) -> LlmConfig:
    return LlmConfig(model_path=tmp_path / MODEL, backend="server", **kw)


def test_resolve_prefers_an_explicit_path(tmp_path: Path) -> None:
    touch(tmp_path, MODEL, "mmproj-gemma-4-26B-A4B-it-qat-F16.gguf")
    cfg = config(tmp_path, mmproj_path="/elsewhere/custom.gguf")
    assert cfg.resolve_mmproj() == "/elsewhere/custom.gguf"


def test_resolve_discovers_without_configuration(tmp_path: Path) -> None:
    touch(tmp_path, MODEL, "mmproj-gemma-4-26B-A4B-it-qat-F16.gguf")
    resolved = config(tmp_path).resolve_mmproj()
    assert resolved.endswith("mmproj-gemma-4-26B-A4B-it-qat-F16.gguf")


def test_resolve_is_empty_for_the_inproc_backend(tmp_path: Path) -> None:
    # llama-cpp-python has no per-family image chat handler in the pinned CPU
    # build, so advertising vision here would promise what no request can use.
    touch(tmp_path, MODEL, "mmproj-gemma-4-26B-A4B-it-qat-F16.gguf")
    cfg = LlmConfig(model_path=tmp_path / MODEL, backend="inproc")
    assert cfg.resolve_mmproj() == ""

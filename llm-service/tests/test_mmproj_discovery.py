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


def test_never_hands_a_model_the_projector_of_another_family(tmp_path: Path) -> None:
    """Gemma's projector made Qwen3 fail to start, and the service fell back
    to the previous model."""

    touch(tmp_path, "Qwen3-14B-Q4_K_M.gguf", "mmproj-gemma-4-26B-A4B-it-qat-F16.gguf")
    assert discover_mmproj(tmp_path, "Qwen3-14B-Q4_K_M.gguf") == ""


def test_a_projector_without_a_model_name_still_counts(tmp_path: Path) -> None:
    """Upstream repos often ship it as `mmproj-F16.gguf` next to the weights."""

    touch(tmp_path, MODEL, "mmproj-F16.gguf")
    assert discover_mmproj(tmp_path, MODEL).endswith("mmproj-F16.gguf")


def test_resolve_is_empty_once_vision_is_switched_off(tmp_path: Path) -> None:
    from dataclasses import replace

    touch(tmp_path, MODEL, "mmproj-gemma-4-26B-A4B-it-qat-F16.gguf")
    cfg = LlmConfig(model_path=tmp_path / MODEL, backend="server")
    assert cfg.resolve_mmproj()
    assert replace(cfg, vision=False).resolve_mmproj() == ""


def test_a_projector_without_a_model_name_is_judged_by_its_header(tmp_path: Path) -> None:
    """`mmproj-F16.gguf` carried Gemma's vision tower and was handed to
    Qwen3-14B, which has none: llama-server failed to start, then ran the
    model text-only after a second start. The header says whose it is."""

    from gguf_meta import write_metadata

    touch(tmp_path, "Qwen3-14B-Q4_K_M.gguf", MODEL)
    write_metadata(tmp_path / "mmproj-F16.gguf", {"general.architecture": "clip", "general.name": "Gemma 4 26B A4B It", "clip.projector_type": "gemma3"})
    assert discover_mmproj(tmp_path, "Qwen3-14B-Q4_K_M.gguf") == ""
    assert discover_mmproj(tmp_path, MODEL).endswith("mmproj-F16.gguf")


def test_the_header_may_name_the_family_only_by_projector_type(tmp_path: Path) -> None:
    from gguf_meta import write_metadata

    touch(tmp_path, "Qwen3.6-35B-A3B-UD-Q5_K_M.gguf")
    write_metadata(tmp_path / "mmproj-BF16.gguf", {"general.architecture": "clip", "clip.projector_type": "qwen3vl"})
    assert discover_mmproj(tmp_path, "Qwen3.6-35B-A3B-UD-Q5_K_M.gguf").endswith("mmproj-BF16.gguf")
    assert discover_mmproj(tmp_path, MODEL) == ""


def test_a_generic_projector_type_names_no_family(tmp_path: Path) -> None:
    # llava-style projectors say `mlp`; that is a tower, not a model, and the
    # projector counts as it did before headers were read.
    from gguf_meta import write_metadata

    touch(tmp_path, MODEL)
    write_metadata(tmp_path / "mmproj-F16.gguf", {"general.architecture": "clip", "clip.projector_type": "mlp"})
    assert discover_mmproj(tmp_path, MODEL).endswith("mmproj-F16.gguf")

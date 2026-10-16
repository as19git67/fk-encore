"""The GGUF header reader: enough of the format to ask a file which model it
belongs to, without reading its weights."""

from pathlib import Path

import pytest

from gguf_meta import GgufError, read_metadata, write_metadata


def test_round_trips_scalars_and_strings(tmp_path: Path) -> None:
    f = tmp_path / "x.gguf"
    write_metadata(f, {"general.name": "Beispiel Modell", "clip.has_vision_encoder": True, "clip.vision.image_size": 896, "clip.vision.eps": 0.5})
    meta = read_metadata(f)
    assert meta == {"general.name": "Beispiel Modell", "clip.has_vision_encoder": True, "clip.vision.image_size": 896, "clip.vision.eps": 0.5}


def test_skips_arrays_and_stops_once_the_wanted_keys_are_read(tmp_path: Path) -> None:
    # A model's vocabulary is an array of hundreds of thousands of strings; it
    # is skipped element by element, and the read ends at the last wanted key.
    f = tmp_path / "x.gguf"
    write_metadata(f, {
        "general.architecture": "qwen3",
        "tokenizer.ggml.tokens": ["a", "b", "c"],
        "tokenizer.ggml.token_type": [1, 1, 1],
        "general.name": "Qwen3 14B",
        "general.size_label": "14B",
    })
    assert read_metadata(f, ["general.name"]) == {"general.name": "Qwen3 14B"}
    assert "tokenizer.ggml.tokens" not in read_metadata(f)


def test_refuses_what_is_not_gguf(tmp_path: Path) -> None:
    empty = tmp_path / "empty.gguf"
    empty.write_bytes(b"")
    with pytest.raises(GgufError):
        read_metadata(empty)
    junk = tmp_path / "junk.gguf"
    junk.write_bytes(b"GGUF" + b"\x03\x00\x00\x00" + b"\x00" * 4)
    with pytest.raises(GgufError):
        read_metadata(junk)

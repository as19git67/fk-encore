"""Reading the metadata header of a GGUF file.

A GGUF file starts with its key/value metadata, so the questions this
service asks — which model is this projector for? — are answered by the first
few kilobytes and never need the weights. The format is small enough to read
without a dependency: magic, version, tensor count, key count, then one
typed value per key (https://github.com/ggml-org/ggml/blob/master/docs/gguf.md).
"""

from __future__ import annotations

import struct
from pathlib import Path
from typing import Any, BinaryIO, Iterable

GGUF_MAGIC = b"GGUF"

# Value types as numbered in the header. Arrays (9) carry a type and a count.
_SCALARS: dict[int, tuple[str, int]] = {
    0: ("<B", 1),  # uint8
    1: ("<b", 1),  # int8
    2: ("<H", 2),  # uint16
    3: ("<h", 2),  # int16
    4: ("<I", 4),  # uint32
    5: ("<i", 4),  # int32
    6: ("<f", 4),  # float32
    7: ("<?", 1),  # bool
    10: ("<Q", 8),  # uint64
    11: ("<q", 8),  # int64
    12: ("<d", 8),  # float64
}
_STRING = 8
_ARRAY = 9

# A key or string value longer than this is not metadata but a corrupt header;
# a model's tokenizer arrays are skipped element by element, never read whole.
MAX_STRING = 1 << 20


class GgufError(ValueError):
    """The file is not a GGUF file this reader understands."""


def _read(fh: BinaryIO, n: int) -> bytes:
    data = fh.read(n)
    if len(data) != n:
        raise GgufError("truncated header")
    return data


def _read_string(fh: BinaryIO) -> str:
    (length,) = struct.unpack("<Q", _read(fh, 8))
    if length > MAX_STRING:
        raise GgufError(f"string of {length} bytes in header")
    return _read(fh, length).decode("utf-8", errors="replace")


def _skip_string(fh: BinaryIO) -> None:
    (length,) = struct.unpack("<Q", _read(fh, 8))
    fh.seek(length, 1)


def _read_scalar(fh: BinaryIO, value_type: int) -> Any:
    if value_type == _STRING:
        return _read_string(fh)
    spec = _SCALARS.get(value_type)
    if spec is None:
        raise GgufError(f"unknown value type {value_type}")
    fmt, size = spec
    return struct.unpack(fmt, _read(fh, size))[0]


def _skip_value(fh: BinaryIO, value_type: int) -> None:
    if value_type == _STRING:
        _skip_string(fh)
        return
    if value_type == _ARRAY:
        (element_type, count) = struct.unpack("<IQ", _read(fh, 12))
        if element_type == _STRING:
            for _ in range(count):
                _skip_string(fh)
        elif element_type == _ARRAY:
            for _ in range(count):
                _skip_value(fh, _ARRAY)
        else:
            spec = _SCALARS.get(element_type)
            if spec is None:
                raise GgufError(f"unknown array element type {element_type}")
            fh.seek(spec[1] * count, 1)
        return
    spec = _SCALARS.get(value_type)
    if spec is None:
        raise GgufError(f"unknown value type {value_type}")
    fh.seek(spec[1], 1)


def read_metadata(path: Path | str, keys: Iterable[str] | None = None) -> dict[str, Any]:
    """The scalar and string metadata of *path*, or only the *keys* asked for.

    Arrays are skipped: nothing this service wants lives in one, and a model's
    vocabulary is hundreds of thousands of strings. With *keys*, reading
    stops as soon as all of them are found. Raises `GgufError` for a file that
    is not GGUF, including an empty placeholder.
    """

    wanted = set(keys) if keys is not None else None
    out: dict[str, Any] = {}
    with open(path, "rb") as fh:
        if _read(fh, 4) != GGUF_MAGIC:
            raise GgufError("not a GGUF file")
        (version,) = struct.unpack("<I", _read(fh, 4))
        if version < 2:
            raise GgufError(f"GGUF version {version} is not supported")
        (_tensors, kv_count) = struct.unpack("<QQ", _read(fh, 16))
        for _ in range(kv_count):
            key = _read_string(fh)
            (value_type,) = struct.unpack("<I", _read(fh, 4))
            take = value_type != _ARRAY and (wanted is None or key in wanted)
            if take:
                out[key] = _read_scalar(fh, value_type)
                if wanted is not None and wanted <= out.keys():
                    break
            else:
                _skip_value(fh, value_type)
    return out


def write_metadata(path: Path | str, metadata: dict[str, Any]) -> None:
    """A GGUF file holding only *metadata* and no tensors — for tests, and
    for anything else that needs a stand-in header."""

    def string(s: str) -> bytes:
        raw = s.encode("utf-8")
        return struct.pack("<Q", len(raw)) + raw

    body = bytearray(GGUF_MAGIC + struct.pack("<IQQ", 3, 0, len(metadata)))
    for key, value in metadata.items():
        body += string(key)
        if isinstance(value, bool):
            body += struct.pack("<I", 7) + struct.pack("<?", value)
        elif isinstance(value, int):
            body += struct.pack("<I", 4) + struct.pack("<I", value)
        elif isinstance(value, float):
            body += struct.pack("<I", 6) + struct.pack("<f", value)
        elif isinstance(value, str):
            body += struct.pack("<I", _STRING) + string(value)
        elif isinstance(value, list) and all(isinstance(v, str) for v in value):
            body += struct.pack("<I", _ARRAY) + struct.pack("<IQ", _STRING, len(value))
            for v in value:
                body += string(v)
        elif isinstance(value, list) and all(isinstance(v, int) for v in value):
            body += struct.pack("<I", _ARRAY) + struct.pack("<IQ", 4, len(value))
            for v in value:
                body += struct.pack("<I", v)
        else:
            raise TypeError(f"cannot write {key}={value!r}")
    Path(path).write_bytes(bytes(body))

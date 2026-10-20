# aesthetic-service

Scores a photo's aesthetics with [Q-Align](https://huggingface.co/q-future/one-align)
(ICML 2024, MIT), the strongest published aesthetic model (AVA SRCC 0.82).
Stage 1 of `documentation/plans/foto-aesthetik.md`.

The service holds **no model at rest**. Q-Align is an 8 B PyTorch model that
does not fit beside Gemma 4 on the 16 GB card, so the nightly job in the app
lends it the GPU: the llm-service switches Gemma 4 to its CPU configuration,
this service loads Q-Align, scores the backlog, unloads, and the GPU goes
back. Between windows the container idles with a few hundred MB of RAM and
no VRAM.

## Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /healthz` (`/health`) | Container probe, open. `ok` in every state. |
| `GET /status` | `state` (`unloaded` / `loading` / `loaded` / `unloading` / `error`), `error`, `model_id`, `version`, `loaded_at`, `scored`, `vram_used_bytes`. |
| `POST /load` | Start loading, answers `202` at once; poll `/status`. `409` while a load or unload is running. |
| `POST /unload` | Free the GPU, answers `202`; poll `/status`. |
| `POST /score` | Multipart `file`; answers `aesthetics` and `quality` in 1–5, `version`, `model_id`, `elapsed_ms`. `503` unless `loaded`. |

Everything but the probe needs `Authorization: Bearer $INTERNAL_SERVICE_SECRET`
(see `service_auth.py`). Scoring is serialised on one thread; the caller
sends one photo at a time and gets them back in order.

The scores are the model card's raw 1–5 values. The photo service scales
them and writes `ai_quality_details.aesthetic_model = version`, so a later
model or quantisation (a new `SCORER_VERSION` in `scorer.py`) can be told
from an old one and re-scored.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `INTERNAL_SERVICE_SECRET` | (required) | Shared secret, same as the other internal services. |
| `MODELS_DIR` | `/models` | Volume for the weights; `HF_HOME` defaults to `$MODELS_DIR/hf-cache`. |
| `AESTHETIC_MODEL_ID` | `q-future/one-align` | Hugging Face id; downloaded on the first `/load`. |
| `AESTHETIC_DEVICE` | `cuda` | `cuda` or `cpu`. CPU is for a smoke run only (20–60 s per photo). |
| `AESTHETIC_QUANT` | `8bit` | `8bit` (~9 GB), `4bit` (~5 GB) or `none` (fp16, ~16 GB). |
| `AESTHETIC_MAX_EDGE` | `1024` | Longest edge the photo is downscaled to before the model's own 448 px resize. |
| `LOG_LEVEL` | `INFO` | |

## Running the tests

```bash
cd aesthetic-service
pip install fastapi httpx pytest python-multipart Pillow
pytest tests/ -v
```

The tests run with a fake scorer; nothing here needs torch or a GPU. A
scoring run on the real model happens on the host with the card, through
`/load` and `/score`.

## Pins to verify on the first image build

The model card pins `transformers==4.36.1` and its custom mPLUG-Owl2 code
imports `einops` and `icecream`; `requirements.txt` carries those pins. The
combination with torch 2.7.1 (cu128) and bitsandbytes 0.45.0 is taken from
the respective release notes, not yet from a build on the production host.
If the first `/load` fails, `/status` carries the exception, and the pin to
move is almost certainly one of these three.

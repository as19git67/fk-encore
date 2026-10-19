# Aesthetic scoring for photos

## Goal

Score every photo with Q-Align, the strongest published aesthetic model
(AVA SRCC 0.82 against 0.3–0.4 for the zero-shot CLIP signal used today),
in a nightly batch on the GPU that otherwise belongs to Gemma 4. New
photos get a provisional score on the CPU at import so nothing is
unscored during the day. The auto-pick for similar photos
(`photo/group-auto-pick.ts`) should pick the better frame more often;
the gallery may later sort or filter by the score. On request, Gemma 4
explains a photo in words.

## Where we stand

`POST /quality` in `embedding_service/app/api/endpoints.py` computes
`clip_aesthetics`, `clip_composition` and `clip_technical` as the
difference of cosine similarities between the OpenCLIP ViT-H/14 image
vector and hand-written positive/negative sentences ("a beautiful
aesthetically pleasing photograph" against "a boring uninteresting
photograph"). Laplacian blur, contrast, exposure, face sharpness and an
eyes-open score complete the composite. `photo.service.ts` stores the
composite in `photos.ai_quality_score` and the parts in
`photos.ai_quality_details`; the auto-pick weights `clip_aesthetics` at
5 % with a face and 25 % without.

The embedding service and InsightFace run on the CPU (pinned to the
P-cores, optional ONNX/INT8 path). The GPU (16 GB) carries the
llm-service: Gemma 4 26B-A4B through llama-server, the `mmproj` vision
projector and the E5 embedder. The llm-service can swap its model at
runtime (`POST /reload`, `GET /reload/status`, states `idle` →
`stopping` → `downloading` → `loading` → `ready`/`error`), drains the
single-worker inference executor before a swap, and rolls back when a
load fails. The `ai-queue` service hands out slots per model
(`insightface`, `embedding`, `landmark`, `llm`) with priorities and
reports waiting counts; background jobs run through `lib/local-cron.ts`.

## Why Q-Align, and why at night

| Candidate | AVA SRCC | Where it can run | Verdict |
|---|---|---|---|
| Zero-shot CLIP (today) | ≈ 0.3–0.4 | CPU, free | replace |
| LAION-style MLP head on the CLIP vector | ≈ 0.6 (third-party tests) | CPU, free | provisional score at import |
| TOPIQ-IAA, MUSIQ-AVA (`pyiqa`) | 0.73–0.78 | CPU, 0.2–0.5 s | fallback if the GPU job is not possible |
| Q-Align / OneAlign (ICML 2024, MIT) | **0.823** | GPU only (8 B, mPLUG-Owl2); 20–60 s per photo on CPU | **the nightly scorer** |
| Multimodal LLM prompt (Gemma 4) | no benchmark; AesBench puts LLMs well below specialised scorers | GPU, already loaded | explanations only |

Q-Align does not fit beside Gemma 4: in fp16 it needs ~16 GB, in 8-bit
~9 GB, in 4-bit ~5 GB, and the card is full. It also is not a GGUF, so
llama-server cannot host it; it runs in PyTorch/transformers. Hence a
window at night in which the GPU is lent to the scorer and Gemma 4 keeps
running on the CPU.

## Decisions

- **The GPU is lent, Gemma stays available.** During the window the
  llm-service activates a CPU configuration of the same Gemma 4 model
  (`n_gpu_layers = 0`, all experts in system RAM, same `mmproj`, E5 on
  the CPU). The assistant and document classification keep working,
  slower; nothing is switched off. At the end of the window the GPU
  configuration is activated again. Both are ordinary `llm_model_config`
  rows, so the existing reload, rollback and admin page carry it.
- **A separate scorer service, not code in the llm-service.** A new
  container `aesthetic-service` (Python, FastAPI, same `service_auth`
  and `INTERNAL_SERVICE_SECRET` as the others, GPU image based on
  `llm-service/Dockerfile.gpu`) holds Q-Align in 8-bit
  (`bitsandbytes`; fall back to 4-bit if the measured VRAM leaves no
  headroom for the batch). It loads the model only on `POST /load`,
  unloads on `POST /unload`, and scores with `POST /score` (a photo
  file, answers `aesthetics` and `quality` in 1–5 plus the model
  version). Idle, it holds no VRAM. The weights come from Hugging Face
  (`q-future/one-align`, MIT) through the same download mechanism as
  the LLM models, into the models volume.
- **Window: configured start and end, automatic inside it.** A setting
  pair `aesthetic.window_start` / `aesthetic.window_end` (local time,
  default 01:00–06:00, editable under Fotos › Einstellungen › KI-Modell)
  bounds the job. Inside the window the job starts only when the
  `llm` queue in `ai-queue` is empty and no reload is in flight, and
  it checks between batches: the window ended, a reload was requested
  by an admin, or the scorer failed → hand the GPU back. An LLM request
  arriving during the window is served by the CPU configuration and
  does not interrupt the job; only an admin's reload does. A pure
  automatic ("whenever the LLM is idle") was considered and rejected:
  two swaps cost about five minutes of GPU time and a visible slowdown
  of the assistant, so they should happen at a time the household has
  chosen, not whenever a quiet ten minutes appears. The window is the
  automatic's boundary; nothing inside it needs a person.
- **One signal, same name.** The Q-Align aesthetics score (1–5, scaled
  to 0–1) replaces `clip_aesthetics` in `ai_quality_details` under the
  same key, so `group-auto-pick.ts`, the calibration replay and the
  frontend keep working. The quality score goes in as `qalign_quality`.
  `aesthetic_model` names the scorer and version (`"laion_vith_v1"` for
  the provisional score, `"qalign_v1"` for the nightly one), so the job
  finds what still needs scoring.
- **Provisional score at import.** New photos get a score from a small
  MLP head on the CLIP ViT-H/14 vector the embedding service already
  computes, so a photo imported at noon has a score before the night.
  The published LAION head is for ViT-L/14 (768 dims), so the head is
  trained once on ViT-H/14 embeddings of the AVA images (public dataset;
  the embeddings are a one-off batch). The nightly job overwrites it.
- **Composition and technical stay zero-shot for now.** They carry
  15 % and 10 % in the no-face formula; blur and face signals cover most
  of "technical", and Q-Align's `quality` output can take that role
  after calibration.
- **The LLM explains, it does not grade.** Gemma 4 gets a prompt for
  strengths and weaknesses in a few sentences, called only on request
  for one photo or one auto-pick group, through the existing llm-service
  and its queue. The answer is cached on the photo, never used in the
  score.
- **Calibration before weight changes.** Q-Align is trained on
  competition photos (dpchallenge). Before the auto-pick weights move,
  `group-auto-pick.calibration.ts` replays the confirmed picks with the
  new signal and reports whether the hit rate improves. The formula
  changes only with that number in the PR.

## Nightly job

`photo/aesthetic-nightly.ts`, scheduled through `lib/local-cron.ts`
every 5 minutes, each run deciding in this order:

1. Outside the window, or the job is disabled → nothing.
2. Window open, scorer not loaded: if `ai-queue` shows no active or
   waiting `llm` slot and `GET /reload/status` says `idle`, activate the
   CPU configuration (`POST /reload`), wait for `ready`, then
   `POST /load` on the scorer. Record `started_at` in
   `photo_aesthetic_run`. If either step fails, roll back what was done,
   write the error to the run and stop until the next night.
3. Scorer loaded: take the next batch (200 photos whose
   `aesthetic_model` is missing or older than `qalign_v1`, newest
   first, through the existing processing path that resolves the file
   and HEIC conversion), score, write `ai_quality_details` and
   recompute `ai_quality_score` with the existing composite. Repeat
   while the window is open and no admin reload was requested.
4. Window closed, or an admin reload requested, or the queue of
   unscored photos is empty: `POST /unload`, activate the GPU
   configuration, wait for `ready`, close the run with counts and
   duration.

A run table `photo_aesthetic_run` (started, ended, scored, failed,
model, error) feeds a small panel under Fotos › Einstellungen › KI-Modell:
last run, photos scored, photos remaining, window, on/off switch, and
"Jetzt starten" for an admin who wants a run outside the window. Admin ›
Jobs lists it like the other local-cron jobs.

Throughput expectation: Q-Align in 8-bit scores a photo in roughly
0.3–0.6 s on this card, so a five-hour window covers 30 000–60 000
photos; a large library is done in a few nights, after that a night
handles the day's imports in minutes. These numbers are estimates and
go into this plan once measured.

## Stages

1. **Scorer service** — `aesthetic-service/` with `POST /load`,
   `POST /unload`, `POST /score`, `GET /status` (loaded, VRAM used,
   model version); Dockerfile from the GPU image; compose entry with the
   GPU reservation; model download into the models volume. Test: the
   service answers `/status` without a model and refuses `/score` until
   loaded; a scoring test runs only where a GPU is present.
2. **GPU hand-over in the llm-service** — a CPU configuration for the
   production model (seeded `llm_model_config` row, `n_gpu_layers = 0`,
   experts in RAM) and a check that reload drains in-flight requests and
   that `/reload/status` exposes enough for the job. Measure the CPU
   speed of Gemma 4 for a typical assistant turn and record it here.
3. **Nightly job, window setting, run table, admin panel** — as above.
   Backfill endpoint `POST /photos/aesthetic/backfill?model=` that marks
   photos for re-scoring without touching the rest of the quality job.
4. **Provisional score at import** — the MLP head on ViT-H/14 in
   `compute_quality`, writing `clip_aesthetics` and
   `aesthetic_model = "laion_vith_v1"`.
5. **Calibration and weights** — replay in
   `group-auto-pick.calibration.ts`, raise the aesthetic weight only with
   the measured gain; consider `qalign_quality` for the technical share.
6. **Explanation in words** — `POST /photos/:id/critique`, Gemma 4
   through the llm-service, cached in `photo_critique`, shown behind a
   button on the photo page and in the auto-pick review.

## Sources

Q-Align (ICML 2024) and the OneAlign model card with AVA/KonIQ figures
and the MIT license; VILA (CVPR 2023); the `pyiqa` model cards for
`topiq_iaa`, `musiq-ava`, `nima` and `laion_aes`; LAION-Aesthetics and
the improved aesthetic predictor; AesBench and UNIAA for the LLM
comparison; the llm-service README for the VRAM budget and the reload
mechanism. The research summary with links lives in the project thread.

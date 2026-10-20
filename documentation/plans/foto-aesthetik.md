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

## Where the score is used

The composite `photos.ai_quality_score` already drives more than the
auto-pick, so a better aesthetic signal reaches these places on its own
once the composite is recomputed:

- the auto-pick for similar photos (`photo/group-auto-pick.ts`), which is
  where the calibration happens;
- the cover of an orientation variant group (`photo/orientation-variants.ts`)
  and of a duplicate group (`photo/duplicate-candidates.ts`);
- the year recaps (`photo/recaps.service.ts`): best photo of a day, "then
  and now" pairs, the highlight order;
- the photo stops on the trip map (`usePhotoStops.ts`, `TripMap.vue`),
  which show the best-scored photo of a stop;
- the gallery and album sort "Qualität" and the filter `qualityMin` /
  `qualityMax` (`photo/photo.filters.ts`, `utils/photoFilter.ts`).

Beyond that, with the aesthetic value available on its own:

- **Sort and filter "Ästhetik"** next to "Qualität" in gallery, album and
  the iOS app, so a sharp but dull frame and a slightly soft but beautiful
  one can be told apart; the detail sidebar shows both values.
- **Album cover suggestion**: the highest-scored photo of an album as the
  default cover, and in the album editor a "best candidates" strip.
- **Rule collections** (`collections/rules.ts`): a rule "aesthetics above
  X" so "the best photos of this year" is a live collection that fills
  itself and can be exported or shared.
- **Shared albums and public links**: the order in which a shared album
  or a public share link opens, best first, so a visitor sees the strong
  frames before the 40 similar ones.
- **Review queue and photo release** (`ReviewQueueView.vue`, the release
  workflow in `documentation/plans/foto-freigabe.md`): pre-sort the queue
  by the score so an approver sees the likely keepers first, and mark the
  bottom of a burst as "probably reject".
- **Assistant** (`assistant/tools/`): a tool `best_photos` (person, place,
  time range, minimum score) so "zeig mir die schönsten Fotos vom
  Urlaub" works and the result can land in a collection.
- **Feed and widgets**: a "photo of the day" in the feed and the iOS
  widget picks among the top-scored photos of the day's anniversary
  instead of a random one.
- **Import culling**: a bulk action "hide everything below X in this
  burst" offered in the auto-pick review, never automatic.
- **Critique in words** (stage 6): the explanation next to the score on
  the photo page and in the auto-pick review.

Each of these is its own small change after stage 3; none is a
prerequisite for the nightly job.

## Stages

1. **Scorer service** — `aesthetic-service/` with `POST /load`,
   `POST /unload`, `POST /score`, `GET /status` (loaded, VRAM used,
   model version); Dockerfile from the GPU image; compose entry with the
   GPU reservation; model download into the models volume. Test: the
   service answers `/status` without a model and refuses `/score` until
   loaded; a scoring test runs only where a GPU is present.
2. **GPU hand-over in the llm-service** — *done.* Not a seeded row after
   all: a row would name a file that only the production host knows, and
   an activation flips `is_active` and persists, which a hand-over for
   the night must not. Instead the llm-service derives the *CPU twin* of
   whatever is running (`cpu_twin()` in `main.py`: `gpu_layers 0`,
   `n_cpu_moe 0`, `accelerator cpu`, everything else kept) on
   `POST /gpu/lend`, moves the embedder to the CPU, and restores both on
   `POST /gpu/return`; `/reload/status` carries `lease` and the twin runs
   with `source: "lease"`. Nothing is persisted, so a restart in the night
   boots on the GPU; an admin's `/reload` or `/config/reset` ends the
   lease. A lend that fails rolls back to the GPU and clears the lease; a
   return that fails (the scorer still on the card) keeps the twin and
   the lease for a retry. The app side is `lendLlmGpu`, `returnLlmGpu`
   and `getLlmGpuLease` in `user/llm-models.ts` (service-internal), and
   the KI-Modell page says when the card is lent. Reload drains the
   single inference worker before the swap (`_drain_inference`), and
   `_reload_worker` now restores the previous configuration under its own
   source on rollback. The measurement has a button: the KI-Benchmark page
   (Dokumente › Einstellungen) can run its cases "on the CPU twin", which
   lends the GPU for the run through the same endpoints and returns it
   afterwards (`device: "cpu"` on `POST /assistant/benchmark/runs`; the
   history shows GPU and CPU runs side by side with median and p90 per
   round). The twin does not inherit the GPU configuration's `threads`
   (small on the card, where the CPU only feeds the GPU): it takes
   `LLM_CPU_THREADS` or one thread per CPU of the container's cpuset, so
   the night runs on all the cores it was given. Measured on the host
   (2026-10-20, Gemma 4 26B-A4B, full case list, 6 P-cores):

   | Device | Median | p90 |
   |---|---|---|
   | GPU | 890 ms | 2.1 s |
   | CPU twin, 6 threads | 4.4 s | 11.2 s |
   | CPU twin, 12 threads | 3.9 s | 9.6 s |

   The twin answers about 4–5× slower than the card; the hyper-threading
   siblings help a little, so `LLM_CPU_THREADS` may stay empty (one thread
   per CPU of the cpuset). An assistant turn in the night is slow but
   usable, and the classification queue drains at a fraction of its daytime
   rate, which is what stage 3 sizes its batches against.
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

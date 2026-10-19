# Aesthetic scoring for photos

## Goal

Replace the zero-shot CLIP "aesthetics" signal in the photo quality score
with a trained aesthetic scorer, keep everything on the CPU so the GPU
stays with Gemma 4, and offer an explanation in words on request. The
auto-pick for similar photos (`photo/group-auto-pick.ts`) should pick
the better frame more often; the gallery may later sort or filter by the
score.

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

Zero-shot CLIP text similarity is the weakest known aesthetic signal: its
rank correlation with the AVA ratings is around 0.3–0.4, which is why
LAION trained a small head on top of the CLIP embedding in the first
place. Everything else in the pipeline (service returns signals,
TypeScript weights them, calibration replays confirmed picks) can stay.

## The hardware constraint

The GPU (16 GB) is fully taken by the llm-service: Gemma 4 26B-A4B with
its KV cache, the `mmproj` vision projector and the E5 embedder. The
embedding service and InsightFace already run on the CPU, pinned to the
P-cores (`DEPLOY_ML_CPUSET`), with an optional ONNX/INT8 path for the
CLIP visual tower. System RAM is plentiful. So the scorer runs on the
CPU inside the embedding service, next to the models that already live
there, and nothing new is loaded on the GPU.

What that allows and what it rules out:

| Candidate | AVA SRCC | Weights | CPU cost per photo (estimate) | License | Verdict |
|---|---|---|---|---|---|
| Zero-shot CLIP (today) | ≈ 0.3–0.4 | none | ~0 (vector exists) | — | replace |
| LAION aesthetic head (MLP on CLIP) | not published; ≈ 0.6 range in third-party tests | 1 MB | ~0 (vector exists) | MIT | stage 1, needs a head for ViT-H/14 |
| TOPIQ-IAA (`pyiqa`) | ≈ 0.78 | ~100 MB, ResNet-50 | 0.2–0.5 s | Apache 2 | stage 2, preferred |
| Aesthetic Predictor v2.5 (SigLIP so400m) | not published | ~0.9 B params, 1.7 GB fp16 | 1–3 s fp32, less with INT8 | AGPL-3.0 | stage 2 alternative, license noted |
| Q-ReAlign-Mini 0.8B | 0.86 average over 7 sets (vendor figure) | ~1.6 GB | 2–5 s, unverified | check model card | stage 3 candidate |
| Q-Align / OneAlign 8B | 0.823 | ~16 GB fp16, 5 GB 4-bit | 20–60 s | MIT | not on CPU; only as a GPU batch job when the LLM is idle |
| Gemma 4 vision prompt | no benchmark | already loaded | GPU, shares the LLM queue | — | explanations only, never the number |

The CPU estimates are from the model sizes and the measured CLIP ViT-H
timings in the embedding service; stage 2 measures them on the host
before any default changes.

Swapping Gemma 4 out for Q-Align in a nightly window is possible (the
llm-service can reload a configuration) but is not planned: the gain
over TOPIQ is a few points of correlation and the cost is a second
inference stack on the GPU, a window in which the assistant and
document classification stand still, and a backfill that has to fit that
window.

## Decisions

- **One signal, same name.** The new score replaces `clip_aesthetics` in
  `ai_quality_details` under the same key, scaled to 0–1, so
  `group-auto-pick.ts`, the calibration replay and the frontend keep
  working. A second key `aesthetic_model` names the scorer and version
  (`"topiq_iaa"`, `"laion_vith_v1"`), so a backfill can find photos
  scored by an older one.
- **Composition and technical stay zero-shot for now.** They carry
  15 % and 10 % in the no-face formula; the blur and face signals cover
  most of "technical" already. Revisit after the aesthetic score is in.
- **CPU only.** The scorer loads lazily in the embedding service like
  CLIP and DINOv2, with an ONNX/INT8 export where one is cheap to make.
  No model is added to the llm-service.
- **The LLM explains, it does not grade.** AesBench and UNIAA show
  multimodal LLMs well below specialised scorers on the number, but they
  are good at naming what is wrong. Gemma 4 gets a prompt for strengths
  and weaknesses in a few sentences, called only on request for one
  photo or one auto-pick group, through the existing llm-service and its
  queue. The answer is cached on the photo, never used in the score.
- **Calibration before weight changes.** Every scorer is trained on
  competition photos (dpchallenge). Before the auto-pick weights move,
  `group-auto-pick.calibration.ts` replays the confirmed picks with the
  new signal and reports whether the hit rate improves. The formula in
  `group-auto-pick.ts` changes only with that number in the PR.
- **Backfill through the existing queue.** The quality job already runs
  per photo through the `embedding` fetch queue; a backfill selects
  photos whose `aesthetic_model` is missing or older and re-runs just
  the scorer, not the whole quality job, at the low background priority
  the cpuset and `cpu_shares` already give the ML containers.

## Stages

1. **LAION head on the existing embedding** — cheapest possible
   improvement, no new inference.
   The published head expects CLIP ViT-L/14 (768 dims); the service runs
   ViT-H/14 (1024 dims). Train the same two-layer MLP on ViT-H/14
   embeddings of the AVA images (the dataset is public; ~250 000 images;
   extracting the embeddings is a one-off batch, on the GPU host in a
   quiet window or on the CPU over a weekend). Ship the head as a small
   `.safetensors` next to the ONNX files, load it in `compute_quality`,
   write `clip_aesthetics` from it and `aesthetic_model = "laion_vith_v1"`.
   Test: a fixed set of synthetic images (gradient, noise, a rendered
   composition) with expected ordering; and a unit test that the head
   loads and returns a value in 0–1.

2. **Dedicated scorer on the CPU** — TOPIQ-IAA from `pyiqa`, measured
   against Aesthetic Predictor v2.5 on the host.
   Add `pyiqa` to `embedding_service/requirements.txt`, load `topiq_iaa`
   lazily, export to ONNX if the measured latency on the P-cores is
   above about half a second. Measure both candidates on 200 photos from
   the library (time per photo, RAM, and rank agreement with the stage 1
   head and with the confirmed picks). Pick one, write its score as
   `clip_aesthetics`, bump `aesthetic_model`. If v2.5 wins clearly, note
   the AGPL license in `embedding_service/README.md`; running it inside
   the own instance is fine, but the service's source must stay
   available as it is.
   Backfill endpoint in the photo service (`POST /photos/quality/backfill?model=`)
   that re-scores only the aesthetic signal.

3. **Calibration and weights** — replay in
   `group-auto-pick.calibration.ts` with the new signal, compare the hit
   rate on confirmed picks, and raise the aesthetic weight (the no-face
   formula first) only when the replay shows a gain. Record the numbers
   in this plan.

4. **Explanation in words** — `POST /photos/:id/critique` in the photo
   service, calling the llm-service's vision endpoint with a prompt that
   asks for three strengths, three weaknesses and one suggestion in
   German, in plain sentences, no score. Cached in a new table
   `photo_critique` (photo id, model, text, created at). The photo detail
   page shows it behind a button "Was sagt die KI?"; the auto-pick review
   offers it for the group. Queued behind document classification; never
   run in bulk.

5. **Optional, later: GPU scorer in a window** — only if stages 1–3
   leave the auto-pick visibly wrong on the family's own photos. Q-Align
   as a batch job through the llm-service's reload mechanism in a nightly
   window; or Q-ReAlign-Mini on the CPU if its model card holds up.
   Decide with the stage 3 numbers, not before.

## Sources

Q-Align (ICML 2024) and the OneAlign model card with AVA/KonIQ figures;
VILA (CVPR 2023); the `pyiqa` model cards for `topiq_iaa`, `musiq-ava`,
`nima` and `laion_aes`; LAION-Aesthetics and the improved aesthetic
predictor; Aesthetic Predictor v2.5 (AGPL); AesBench and UNIAA for the
LLM comparison; the llm-service README for the VRAM budget. The research
summary with links lives in the project thread.

# Auto-Pick: from Quality Scorer to Comparator

Concept, not yet implemented. Follow-up work to #873 (focus peaking) and
`documentation/ai-auto-pick.md`.

The basis is three measurement rounds against the production database
(as of 2026-08-07, 511 evaluable reviewed groups):

| Script | Question |
|---|---|
| `diagnose-autopick-faces.mjs` | Does the hit rate suffer from many faces? |
| `diagnose-autopick-delta.mjs` | Which signal produces the score gap Δ? |
| `diagnose-autopick-calibration.mjs` | Does the size of Δ predict the hit rate? |

All three are read-only and repeatable at any time — see
`scripts/photos/README.md`.

## 1. What was measured

### Two refuted hypotheses

Both come from the development side and are recorded here so that
they are not warmed up again.

**Refuted: "`min()` hurts on photos with many faces."** The
hit rate stays flat across the face count (92.5% / 93.6% / 93.6%
for 1–5 faces; the drop to 86.8% at 6–15 is within the noise at n=38).
σ(face_sharpness) does not increase with the face count.

**Refuted: "`face_coverage` produces the Δ."** In fact `face_sharpness`
dominates the Δ in all confidence buckets (99% / 75% / 64% of the
median Δ). The prediction rested on a flawed inference: from σ(face_sharpness)
≈ 0.035 across *all* groups it was concluded that the signal could not, at weight
0.40, produce a Δ of 0.10. But the `high` groups are exactly the
subset with a large Δ — a selection effect. Applying the unconditional mean
to the very condition that produces it leads you astray.

### The solid finding

**Within a similarity group, almost nothing differentiates.** Contributions
to the Δ in the `high` groups:

| Signal | Median contribution |
|---|---|
| `face_sharpness` | 0.1649 (99%) |
| `eyes_open` | 0.0097 |
| `clip_aesthetics` | **0.0000** (mean −0.0007) |
| `blur` | **0.0000** |

Aesthetics and global sharpness contribute exactly nothing to the distinction.
This is not a surprise but a matter of definition: similar images have
similar aesthetics. σ(blur) within the groups is 0.000.

**Δ is not monotonic with the hit probability.** Lift over
a hypergeometric random baseline:

| Δ range | Groups | Lift |
|---|---|---|
| 0.00–0.02 | 337 | +0.0 pp |
| 0.02–0.04 | 12 | +6.7 pp |
| 0.04–0.06 | 18 | +18.9 pp |
| 0.06–0.10 | 58 | **+25.2 pp** |
| 0.10–0.15 ← `high` from here | 28 | +11.9 pp |
| 0.15–0.25 | 36 | +5.7 pp |
| 0.25+ | 22 | +6.1 pp |

Inverted U-shaped, reproduced in a second sample (only exactly reproducible
scores, n=301). By confidence bucket:

| Bucket | Hit rate | Lift | Behavior |
|---|---|---|---|
| `low` | 96.8% | +0.2 pp | nothing |
| `medium` | 90.8% | **+23.7 pp** | marker only |
| `high` | 75.6% | +7.8 pp | **hides without asking** |

The only bucket that hides automatically is the second worst.
The best merely shows a marker.

**In two thirds of the cases the model does not decide at all.** 337 of the 511
groups sit at Δ≈0. There, multi-pick (`MULTI_PICK_THRESHOLD` 0.92) kicks in
and selects on average 2.33 of 2.3 members — that is, practically all. A
hit is thus guaranteed, the baseline is just as high, the lift zero. That
is not a wrong decision but an **abstention**.

## 2. The structural diagnosis

> The model is an **absolute quality scorer** but is used as a
> **comparator within a group**.

Around 0.85 of the weight lies on signals that are constant within a group.
They raise the absolute score but contribute nothing to the ranking. This is not a tuning problem but a design flaw: it
measures what makes an image good, instead of what *distinguishes* the images
*from one another*.

All three symptoms follow from this:

- **Δ is useless as a confidence.** If effectively only one signal varies,
  Δ is at its core "how much did this one signal fluctuate". A very large Δ
  is then more likely an outlier in a `min()`-aggregated, noise-prone
  signal than a real quality difference — hence the drop of the lift at
  large Δ.
- **Calibration cannot take hold** (0.608 against baseline 0.590). The
  pairwise regression has the right form — it learns on signal
  *differences*. But no distinguishing weights can be
  learned if the features do not vary.
- **The high abstention rate.** Without varying features the scores lie
  close together, multi-pick kicks in, no decision is made.

### Why `min()` does not just add noise to the variance but *deletes* it

A mechanism that has so far been overlooked and explains the abstention rate:
`face_sharpness` is the minimum over all detections. If the
least sharp face is consistently the same tiny background face — and
with small faces that is the rule, because they are physically always the
least sharp — then the minimum across all frames of a burst is
**identical**. The sharpness of the main subject, which does fluctuate
between shots, is completely masked by the constant minimum.

So the variance is present in the pixels, but is thrown away by the aggregation
before it reaches scoring. This is the concrete explanation
for why so many groups land at Δ≈0 — and at the same time the well-founded
expectation that a prominence-weighted aggregation will uncover it.

## 3. Target picture: two regimes

Formulated by the user and supported by the measurement:

**Regime A — faces prominent.** One looks more closely. Facial details
decide: sharpness of the *relevant* face, eyes open,
gaze direction. Everything else is constant within the group.

**Regime B — faces small or none.** Here crop, exposure and moment
actually vary; the existing signals can achieve something.

Today's binary switch `face_count > 0` is a broken approximation of exactly
this distinction — a single false detection in the background pushes
a landscape photo into regime A and thereby throws `clip_composition` and
`clip_technical` out of the scoring. Prominence answers not only "which
faces should I measure", but the upstream question: **which regime
is this group in?**

### Relevance weight

```
w(face) = prominence(face) · identity_bonus(face)
```

Prominence (bbox area, with a lower bound) is the primary criterion — the same
insight as with focus peaking (`MIN_RENDERED_FACE_PX`): a 15 px face
cannot be judged, no matter whom it belongs to.

Identity acts **only as a bonus, never as a penalty**: assigned persons get
`1 + KNOWN_BONUS`, all others `1` — including explicitly ignored ones.

### Why ignored faces are *not* excluded

The `ignored` flag mixes two statements that cannot be told apart in the database
(both `ignored = TRUE, person_id = NULL`):

1. "That is not a face at all" — false detection.
2. "That is a face, but a stranger who does not belong in my person index."

For case 2 the following holds: a stranger depicted sharply is still sharp. An
image with five sharp people is better than one with three sharp and
two blurred — regardless of whether you know them. False detections
are filtered out via **prominence**, not via the flag; that catches
the ones nobody ever ignored, too.

The flag is written exclusively by explicit user actions
(`ignoreFaceLogic`, `ignorePersonFacesLogic`) — it reliably reflects
user intent, but one about *person management*, not about
*image quality*.

### Why an identity bonus is harmless

The score is compared exclusively *within* a similarity group,
never across the library. A systematic boost of
photos of people therefore does not distort any ranking between landscape and portrait —
it only acts where two shots of the same scene are pitted against each other.

## 4. Data situation

| Data | Available? |
|---|---|
| bbox per face | **yes** (`faces.bbox`) |
| Person assignment / ignored | **yes** (`user_face_assignments`) |
| Sharpness **per face** | **no** — only the minimum |
| Eyes open **per face** | **yes** since Stage 5 (`faces.eye_aspect`, `faces.eye_aspect_68`) |
| Gaze direction | **no** — but see below |

`faces.quality` exists, is set to a constant `100` on insert,
and carries no information.

**Gaze direction is cheaper than expected.** The InsightFace service already returns
`kps` in `/detect` — five landmarks per face (eye centers,
nose tip, mouth corners). In the photo service `kps` does not occur even once;
the data is discarded. Head rotation and tilt can be derived from it
geometrically (nose offset relative to the eye line → yaw angle,
tilt of the eye line → roll angle). No new model, but
persistence plus re-detection.

**Eye openness is not possible this way.** Five landmarks give eye *centers*, not
eyelid contours. That would still require CLIP per crop or a
68-point model — the most expensive of the three options.
*Correction (2026-10):* the service runs the `buffalo_l` pack, which already
contains a 106-point and a 68-point landmark model; `FaceAnalysis.get()`
runs both on every face. Only the five `kps` were returned. Eyelid contours
were therefore free all along — see Stage 5.

Sharpness per face needs a backfill, but a cheap one: the
Laplacian variance over a bbox crop is pure pixel arithmetic. No
CLIP, no GPU. The formula already exists, unit-tested, in
`frontend/src/utils/focusPeaking.ts` and would have to be mirrored server-side with `sharp`.

## 5. The goal, precisely

Two things, in this order.

### Goal 1: Widen the decision band

Today the model decides meaningfully only in a narrow range —
Δ ∈ [0.04, 0.15], that is 86 of 511 groups (17%). In 66% it
abstains (multi-pick), above that it becomes unreliable.

"Widen" means: **lower the abstention rate without worsening the hit
rate.** Three levers, in ascending effort:

1. **Uncover the existing variance** — prominence-weighted aggregation instead of
   `min()`. According to Section 2, the sharpness variance of the main subject is already
   in the data but is masked by the constant minimum. This is the
   lever with the best ratio of effort to effect.
2. **Add signals that vary by construction** — gaze direction, and
   eventually eye state per face. Between two shots of a
   burst exactly these things change: people move, blink,
   turn their heads. They are also the ones by which the user actually
   decides.
3. **Compute group-relative instead of absolute.** Do not weight the absolute
   signal difference, but its ratio to the spread of *this signal
   in this group*. A difference of 0.02 in a signal that is otherwise rock-steady is more
   meaningful than 0.10 in one that jumps around in
   this group anyway. A pure algorithm change, no new data — and the
   direct attack on "Δ does not measure what it claims to".

Success metric: share of groups with a demonstrated lift, held against the
hit rate. Not "higher score", but "more often a decision that holds".

### Goal 2: Make auto-hiding honest

Today the system claims confidence ("high") on the basis of a
score gap which has been measured not to correlate with
correctness above 0.10. That is the core of the problem — not the height of
the threshold.

The guiding principle:

> **Trust is measured, not asserted.**

Concretely: the confidence rating is no longer derived from the score gap,
but from the **hit rate measured on the user's own reviews**
for the respective range. The system may hide automatically exactly when it has
earned this permission on this user's data — evidenced by lift and hit rate above a
fixed threshold. If no range reaches this threshold, auto-hiding stays
**off**, and the system restricts itself to the marker.

Notably, the machinery for this already exists. The
bulk-accept dialog already shows the user their agreement rate today —
it just is not tied to the decision whether hiding is allowed at all.
And `diagnose-autopick-calibration.mjs` measures exactly the quantity
needed for it.

An obvious but rejected shortcut: "then just set `high` to
the interval with the best lift (0.04–0.15)". That would be a
curve fit to n=86 and also hardly explainable ("at a medium gap
we hide, at a large one we do not"). The cause of the drop at large Δ is
not understood — as long as it is not, restraint is the more honest
answer than a threshold fitted to the curve.

**What is not the goal:** a system that takes over the selection. The
overall lift is +5.0 pp, in the best range +25 pp. What is realistic is
a good pre-sorting with honest self-disclosure of how certain it
is — not automation of culling.

## 6. Stages

**Immediately, without dependencies: switch off auto-hiding for `high`** (or
put it behind a per-group confirmation). Backed by data: 75.6% hit rate
at +7.8 pp lift, while `medium` without any hiding delivers +23.7 pp.
A product decision, technically trivial. **Done:** default of
`aiHiddenMode` in `photo/photo.filters.ts` changed from `exclude` to `include`
— `high`-confidence groups now behave like `medium`
(conspicuous marker, no automatic hiding). `exclude`/`only`
remain as an explicit query parameter for callers that still need the
old behavior.

**Stage 1 — prominence from bbox.** Relevance weight, smooth
regime transition instead of `face_count > 0`, `face_coverage` only over prominent
faces, presence of known persons as a weak signal. No
re-scan needed, fully validatable offline. **Done:**
`computeFaceProminence()` and the regime blend in
`photo/group-auto-pick.ts`, fed from `faces.bbox` +
`user_face_assignments` (`loadFaceProminenceData()` in
`photo/group-auto-pick.service.ts`). The thresholds
(`PROMINENCE_FLOOR`, `PROMINENCE_SATURATION`, `KNOWN_BONUS`,
`FACE_REGIME_THRESHOLD`) are initially reasoned starting values and will be determined
via the replay.

**Stage 2 — sharpness per face.** New column `faces.sharpness`, filled by a
background job analogous to the dimensions backfill. Only with this does the
actual criterion become measurable: "the shot in which the face of the
known person is sharp". Side effect: focus peaking in the frontend could
read the values instead of recomputing them on every view.
**Done — data collection, without any formula change:**

- Column `faces.sharpness` (migration `0142_face_sharpness.sql`), `NULL`
  remains a state of its own: "not yet measured" or "too small to
  judge" is expressly *not* 0.0 — a tiny detection with 0.0
  would pull a weighted mean down just as `min()` does
  today.
- `photo/face-sharpness.ts`: Laplacian variance over the bbox crop, mirrored
  server-side with `sharp` from `frontend/src/utils/focusPeaking.ts`
  (same 128×128 sample, same full scale of 500, same
  skipping of the edge row instead of `np.roll`) — so the same number appears
  on screen and in the score.
- Measured during the scan (`detectPhotoFaces`) and for existing data via
  `POST /photos/backfill-face-sharpness` — bundled per photo (one decode
  serves all faces of a photo), resumable via a cursor, with a
  button "Gesichtsschärfe nachtragen" (backfill face sharpness) under Fotos › Einstellungen › Wartung.
- If the orientation of the own decode does not match that of the detector,
  the value stays `NULL` instead of being plausibly wrong.

**First production run (2026-08-13): no verdict, measurement setup broken.** The
report said "V1 does NOT hold" — the statement is worthless, for two
independent reasons, both of which have since been fixed:

1. **Coverage 3.3%** (4,218 of 129,633 faces). Only 70
   of 6,801 groups were evaluable — a tiny, non-random subset.
2. **The scale saturates.** σ was exactly 0 in *both* columns and "weighted >
   min" in exactly 0.0% of the groups. Two different aggregations that never
   diverge are computing on identical numbers. Cause:
   `LAPLACIAN_FULL_SCALE` (500) is calibrated on the frontend, which measures the
   *rendered*, downscaled file (`img.naturalWidth` in
   `useFocusPeaking.ts`). Server-side the original is read — the same
   crop carries significantly more high-frequency content there and ends up at the
   1.0 ceiling. A σ of 0 then measures the normalization, not the images.

From this follows the actual lesson for this stage: **a metric that
can only take one value refutes nothing.** The flawed inference is the same
as in the second refuted hypothesis in Section 1 — inferring from a
metric a condition that it does not support.

Consequences, implemented:

- **The raw variance is stored as well** (`faces.sharpness_variance`,
  migration `0143`). The full scale can thereby be determined from the data —
  as demanded in Section 7, measured instead of guessed — and
  rescaling is an `UPDATE`, not a second run over 130,000 crops.
- The backfill now also picks up faces that already have a
  score but no variance yet.
- The diagnostic script reports the distribution (share at the 1.0 ceiling,
  percentiles of score and raw variance), separates "still to be backfilled" from
  "below the measurement limit" — and **refuses to give a verdict** as long as
  coverage is incomplete, the scale saturated or the evaluable set too
  small.

**Next:** let the backfill run through completely, reset the full scale
based on the raw-variance distribution, then measure again. Only then
is V1 testable at all — and only its result decides whether the
aggregation in `scorePhoto()` is touched.

**Stage 3 — persist `kps` → gaze direction.** Re-detection needed,
but no new model.

**Stage 4 — group-relative normalization.** A pure algorithm change,
can come in between at any time; only makes sense once several varying signals
are available.

**Stage 5 — eyes open per face.** Turned out to be the cheap option
(see the correction in Section 4). **Done — data collection, without any
formula change:**

- `/detect` of the InsightFace service also returns `landmark_2d_106` and
  `landmark_3d_68` (x/y in image pixels).
- Columns `faces.landmarks` (JSON `{ kps, lm106, lm68 }`, normalised like
  `bbox`), `faces.eye_aspect` and `faces.eye_aspect_68` (migration
  `0272_face_landmarks.sql`). `kps` is persisted at the same time, so
  Stage 3 (gaze direction) needs no further re-detection.
- `photo/face-eyes.ts`: `eye_aspect` is height over width of each eye
  contour of the 106-point set along its principal axis (independent of
  point order and head tilt), `eye_aspect_68` the textbook EAR
  (Soukupová & Čech 2016). Mean of both eyes, measured in pixels. Faces
  narrower than `MIN_EYE_FACE_PIXELS` (48) keep `NULL`. Only raw ratios are
  stored; where "closed" begins is for the replay to decide.
- Measured during the scan and for existing data via
  `POST /photos/backfill-face-landmarks` (button "Gesichtslandmarken
  nachtragen" under Fotos › Einstellungen › Wartung). The button queues
  one `face_landmarks` scan-queue job per photo that owes something (migration
  0275), so the work runs in the background and shows on the scan-queue page.
  The job re-detects and matches by box overlap (`matchDetections`, IoU ≥ 0.5)
  instead of a forced rescan, which would delete the face rows and every
  person assignment with them.
- `scripts/photos/diagnose-eyes-open.mjs` compares both ratios with the
  CLIP `eyes_open` pairwise in reviewed groups (kept vs. hidden),
  prominence-weighted per photo.

**Next:** run the backfill, then the diagnosis. Only if a landmark ratio
beats CLIP there does it go into the replay with re-learned weights.
**Smile — data collection, without any formula change** (migration
`0273_face_mouth_shape.sql`): `mouthShape` in `photo/face-eyes.ts` measures,
in the face's own frame (eye line as horizontal axis), the mouth width over
the eye distance (`faces.mouth_width`) and how far the corners sit above the
centroid of the lips, over the mouth width (`faces.mouth_lift`); the same
pair from the 68-point model (`_68`). Filled during the scan; the landmark
backfill re-measures faces that already have landmarks from the stored
points without re-detection. Section 3b of `diagnose-eyes-open.mjs` checks
both against the user's decisions, with chance (50 %) as the baseline since
there is no existing smile signal. The same evaluation runs per user from
the card "Augen und Lächeln" under Fotos › Einstellungen › Ästhetik
(`POST /photos/aesthetic/face-signals`, `photo/face-signals-report.ts`).

## 7. Validation: offline replay is mandatory, not optional

Two hypotheses in this project have already failed against the data. For
every further change, therefore: **no formula change without prior
measurement on the historical data.**

The reviewed groups are a ready-made test set — group, stored
signals, actual user decision. What is to be measured is old versus new:

- Hit rate and **lift** overall (lift, not rate — otherwise you compare
  groups of different difficulty)
- Lift per Δ bin: does the curve become monotonic?
- Abstention rate: does the share of Δ≈0 groups fall?
- Number of groups with a changed pick (measure of movement)

Thresholds (`PROMINENCE_SATURATION`, lower bound, `KNOWN_BONUS`) are
**not guessed** but determined via the replay.

### Testable predictions

Formulated explicitly so that they are refutable:

- **V1:** Prominence-weighted sharpness has a higher spread within the
  group than today's minimum. *Testable directly after the backfill in
  stage 2, before any formula change.* If V1 does not hold, the
  core assumption from Section 2 is wrong and stage 2 is pointless. The measurement script
  for it exists: `scripts/photos/diagnose-face-sharpness-variance.mjs`
  (read-only, result still open — the backfill first has to run on the production
  database).
- **V2:** A considerable share of today's Δ≈0 groups gets a Δ different from
  zero. *Testable offline.*
- **V3:** The lift curve over Δ loses its drop at large Δ.
  *Testable offline.*

V1 is the cheapest and at the same time the sharpest test — it decides on
stage 2 before anything in the scoring is touched.

## 8. Open points

- **The cause of the lift drop at large Δ is not understood.** The
  artifact hypothesis (extreme value in a noise-prone minimum) is
  plausible but untested. A filter on the 22 groups with Δ ≥ 0.25 in
  `diagnose-autopick-delta.mjs` would show it.
- **Selection effect:** reviewed `high` groups are not a random sample.
  The replay inherits this but does not distort the old/new comparison as long as
  both run on the same test set.
- **Reproducibility:** only 58.2% of the stored scores can be recomputed exactly with
  today's weights — older groups carry scores
  of earlier formula versions. The core findings were cross-checked on the reproducible
  subset and held up.
- **Existing picks** change through a new formula. Reviewed groups
  are no longer touched, only open ones are affected — something visibly
  moves for the user nonetheless.

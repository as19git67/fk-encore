# AI Auto-Pick: Best-of-Group for Similar Photo Groups

## Summary

Track I of photo organization (issues [#358](https://github.com/as19git67/fk-encore/issues/358) / [#346](https://github.com/as19git67/fk-encore/issues/346)). With 50k+ photos, the DINOv2 similarity search typically produces 5k+ similar groups. Manual review does not scale. The AI scores each group using per-photo signals that already exist, proposes a "best-of-group" pick (or several if the decision is close) and hides the remaining photos behind a marker. The user can accept the proposal, ignore it, or override it via a toggle.

**User decisions always take precedence** — the AI no longer touches reviewed groups.

## Pipeline

```
                     ┌──────────────────────────────────────────┐
                     │  embedding_service (Python)              │
                     │   • DINOv2 embeddings → pgvector         │
                     │   • Quality scorer writes to             │
                     │     photos.ai_quality_details (JSONB):   │
                     │     sharpness, contrast, exposure,       │
                     │     clip_aesthetics/composition/technical,│
                     │     face_sharpness, eyes_open,           │
                     │     face_composition                     │
                     │   • InsightFace → faces.bbox (JSON)      │
                     │   • photos.width / photos.height         │
                     └──────────────────┬───────────────────────┘
                                        │
                                        ▼
        ┌────────────────────────────────────────────────────┐
        │  photo.service.ts                                  │
        │   • findPhotoGroupsLogic – clusters via pgvector   │
        │     → photo_groups, photo_group_members            │
        │   • At the end: recomputeAiPicksForUser() scores   │
        │     all unreviewed groups                          │
        │   • backfillPhotoDimensionsLogic – one-time        │
        │     width/height seed via sharp().rotate()         │
        └──────────────────┬─────────────────────────────────┘
                           │
                           ▼
        ┌────────────────────────────────────────────────────┐
        │  group-auto-pick.service.ts                        │
        │   • loadSignalsForPhotos – one query per batch     │
        │   • Aggregates face_coverage from faces.bbox       │
        │   • Classifies orientation from photos.width/.h    │
        │   • Loads per-user weights from                    │
        │     ai_pick_user_weights, falls back to defaults   │
        │   • Persists in photo_groups.ai_pick_details       │
        └──────────────────┬─────────────────────────────────┘
                           │
                           ▼
        ┌────────────────────────────────────────────────────┐
        │  group-auto-pick.ts (pure logic, no DB access)     │
        │   • scorePhoto – linear combination of the signals │
        │   • computeGroupPick – multi-pick + confidence     │
        │     + orientation diversity                        │
        └────────────────────────────────────────────────────┘
                           │
                           ▼
        ┌────────────────────────────────────────────────────┐
        │  group-auto-pick.calibration.ts                    │
        │   • fitPairwiseWeights – logistic regression       │
        │     over the user reviews                          │
        │   • Persists to ai_pick_user_weights               │
        └────────────────────────────────────────────────────┘
```

## Scoring formula

A score in [0, 1] is computed per photo. The branch depends on whether at least one face was detected. Weights are loaded at runtime from `ai_pick_user_weights` — if no calibration exists, the defaults below apply.

### Face branch (`faces.count > 0`) — default weights

| Signal              | Default | Source |
|---------------------|---------|--------|
| `face_sharpness`    | 0.40    | `ai_quality_details.face_sharpness` |
| `eyes_open`         | 0.20    | `ai_quality_details.eyes_open` |
| `face_coverage`     | 0.15    | Σ(`faces.bbox.width · height`), saturates at 30% |
| `face_composition`  | 0.10    | `ai_quality_details.face_composition` |
| `sharpness` (global)| 0.05    | `ai_quality_details.sharpness` |
| `clip_aesthetics`   | 0.05    | `ai_quality_details.clip_aesthetics` |
| `exposure+contrast` | 0.05    | 0.5 · (`exposure` + `contrast`) |

### Non-face branch — default weights

| Signal              | Default | Source |
|---------------------|---------|--------|
| `sharpness`         | 0.40    | `ai_quality_details.sharpness` |
| `clip_aesthetics`   | 0.25    | `ai_quality_details.clip_aesthetics` |
| `clip_composition`  | 0.15    | `ai_quality_details.clip_composition` |
| `clip_technical`    | 0.10    | `ai_quality_details.clip_technical` |
| `exposure+contrast` | 0.10    | 0.5 · (`exposure` + `contrast`) |

Missing individual signals are mapped to a neutral 0.5 (`clamp01`), so that a photo with an incomplete quality assessment is neither penalized nor rewarded.

## Per-user calibration (stage D)

Learns from the groups that have already been reviewed which signals matter to the user.

**Pairwise logistic regression** over kept-vs-hidden pairs within reviewed groups:
- Per reviewed group: a feature diff is formed for each (kept, hidden) pair
- Face and non-face branches are fitted separately
- Vanilla gradient descent: 600 iters, lr 0.10, positive clipping + sum-to-1 normalization per step
- Persistence in `ai_pick_user_weights`

Safeguard `MIN_PAIRS_FOR_FIT` (10): branches with too little data keep the defaults — a half-trained user should not degrade the other branch.

Trigger: button **"KI auf meine Vorlieben kalibrieren"** (calibrate AI to my preferences) under Fotos › Einstellungen › Wartung. After a fit, the server reports the top-1 hit rate per branch before/after the fit (compared against the defaults); the UI renders this as an info message.

Reversible: `DELETE FROM ai_pick_user_weights WHERE user_id = X` restores the defaults.

## Multi-pick and confidence

```
ranked = photos.sort by score desc
top    = ranked[0]
cutoff = top.score · MULTI_PICK_THRESHOLD  (default 0.92)
picks  = { p ∈ ranked : p.score ≥ cutoff }

Δ = top.score − bestNonPick.score   (or 0 if all are picked)

confidence =
   "high"   if Δ ≥ HIGH_CONFIDENCE_DELTA    (0.10)
   "medium" if Δ ≥ MEDIUM_CONFIDENCE_DELTA  (0.04)
   "low"    otherwise
```

**Orientation diversity:** If the group contains both portrait and landscape photos of the same scene, the best photo of each orientation present is additionally picked — provided it reaches at least `ORIENTATION_FLOOR · top.score` (0.75). Square photos are ignored.

### Redundancy suppression

Multi-pick compares **scores**, not image content — and two shots from the same second score almost identically, precisely *because* they show the same thing. Result before this rule: the group kept the same moment twice, while a sibling photo with different content was hidden.

```
redundant(a, b)  ⟺  DINOv2-cosine(a, b) ≥ REDUNDANCY_SIMILARITY (0.97)
                     ∧ orientation(a) = orientation(b)

accepted = []
for p ∈ picks (best first):
    if accepted is empty OR ¬∃q ∈ accepted: redundant(p, q)  →  accepted += p
    else                                                     →  suppressed += p

# Backfill: for each suppressed pick, one photo with different content
for each suppressed slot:
    replacement = best p ∉ accepted with
                 p.score ≥ DIVERSITY_FLOOR · top.score  (0.85)
                 ∧ ¬∃q ∈ accepted: redundant(p, q)
```

The top score is never suppressed — there is nothing better it could be redundant with. The rule fires only on **positive** redundancy evidence: photos without an embedding appear in no pair and can therefore never drop out of the pick.

**Orientation beats redundancy.** Portrait and landscape shots of the same scene are almost identical to DINOv2, but according to the orientation rule both are deliberately to be kept. Redundancy is therefore judged exclusively *within* an orientation.

**Effect on confidence:** A suppressed pick becomes a non-pick and thus the reference point for Δ. Two nearly identical shots therefore push the group to `low` instead of reporting a large gap to a distant third photo — which is honest: the AI currently does *not* know which of the two is the right one.

The pairwise similarities are provided by the embedding service via `POST /redundant-pairs` (batched across all groups of a recompute run; vectors do not leave the service). If the call fails, scoring proceeds without the rule and the run completes normally — a diversity refinement must not make scoring fail.

## UX

### Gallery (`VirtualGallery.vue`)

- **`high` confidence:** Non-picks are hidden automatically in the grid (server filter `aiHiddenMode=exclude`). The user sees only the pick, with a `+N` marker on the cover.
- **`medium`:** Marker with orange tint, no auto-hide.
- **`low`:** Marker neutral, no auto-hide.

Click semantics in the grid:
- **Click on the photo** → fullscreen view (also for group members)
- **Click on the `+N` marker** → review dialog (`PhotoCompareView`)
- **Ctrl/Cmd/Shift-click** → multi-select of the whole group

In **fullscreen**, the same `+N` marker is shown at the top left, with a `pi-eye-slash` icon for high-confidence hidden siblings. Tap → review dialog.

**Filter toggle "KI-ausgeblendete anzeigen"** (show AI-hidden) in `FilterMenu.vue` next to "Ausgeblendete anzeigen" (show hidden). Active → server filter becomes `aiHiddenMode=include` → all AI-hidden photos become visible again, the marker stays.

### Rapid review (`/fotos/review-queue`)

Its own route + menu entry "Gruppen-Review" (group review). Vertical card list, sorted high → medium → low → no-pick, within the same level by group size descending.

**Per card:**
- Confidence chip + **confidence bar** (visualizes Δ to the runner-up; 0.10 = full bar)
- With **≤ 3 members (stage C):** all photos side by side at equal size. One click on a photo = "keep this one, hide the rest, reviewed". The AI proposal gets a green outline + check icon, but is not a mandatory pick.
- With **4+ members:** AI pick large + sibling strip with dimmed non-picks.
- Action bar: **"KI-Pick übernehmen"** (accept AI pick; atomic) + **"Manuell prüfen"** (check manually; opens `PhotoCompareView` for full granularity).

### Rapid review on iOS (swipe variant)

The iOS app consumes the same `/photos/groups/review-queue` and the same
action endpoints, but presents them as a **card stack instead of a list** — one
group per card, resolved with a single gesture:

| Gesture | Action | Endpoint |
|---|---|---|
| → right | Accept AI proposal | `POST /photos/groups/:id/accept-ai-pick` |
| ← left | Keep all, only mark as reviewed | `POST /photos/groups/:id/review` |
| ↑ up | Favorite the proposal **and** accept it | `PATCH /photos/:id/curation` + accept-ai-pick |
| Tap on a photo | Open large view (no decision) | — |
| „Nur dieses Foto behalten" (keep only this photo) in the large view or context menu | Keep only this one | `POST /photos/groups/:id/pick-photos` |
| „Auswahl anpassen …" (adjust selection …) | Set a free keep set per photo | `POST /photos/groups/:id/pick-photos` (or `/review` if all are kept) |
| Button (with peer signal) | Accept consensus | `POST /photos/groups/:id/accept-peer-consensus` |

Every swipe gesture has an equivalent button — a pure gesture interface
would not be operable with VoiceOver / Switch Control.

**Tapping deliberately decides nothing.** In the first version, a tap
on a thumbnail resolved the group ("keep only this one"). In practice,
though, people tap to *see the photo larger* and to be able to judge the details at all
— gesture and consequence pointed in opposite directions, and a
mistap hid the rest of the group. The tap therefore opens
`ReviewPhotoPreview`: the full image (not the thumbnail), zoomable and
browsable between the group members. Keeping a single photo
is there a labeled button that spells out the consequence ("Die anderen
3 Fotos werden ausgeblendet" (the other 3 photos will be hidden)), additionally reachable via the tile's context menu
and a VoiceOver action.

**Overriding the AI proposal.** Swipe gestures can only *accept* or *keep all*; for everything in between there is `ReviewSelectionSheet` — each group member as a row with thumbs up/down, pre-filled from the AI proposal. As on the web (`PhotoCompareView.vue`), all toggles are **local**; only „Übernehmen" (apply) sends the finished keep set. An empty selection cannot be committed (`pick-photos` requires ≥ 1 keeper), and "keep all" becomes `/review` instead of a `pick-photos` with an empty complement.

A tap on the row thumbnail opens the same large view, but there in **edit mode**: the footer carries the same thumbs, bound to the sheet's keep set. A 64pt tile is not enough to judge sharpness — so the decision has to be changeable exactly where the photo is legible, without the detour back to the list. `ReviewPhotoPreview` has two modes for this: `onPickOne` (from the review card, decides the group immediately) and `keep:` (from the sheet, writes to the pending selection).

**The swipe-up gesture is not a pure favorite marker.** It favorites
the AI proposal *and* resolves the group like the right gesture. Label and
hint text both spell out both halves ("Favorit & übernehmen" (favorite & accept)), because an
action with two effects could otherwise only be learned by trial and error.

**Groups without an AI proposal** can by swipe gesture basically only be
"kept": `pick-photos` requires a non-empty keep set, and hiding all
members would be a destructive surprise. Such groups
are resolved via the large view or the context menu.

**Undo without an un-review endpoint.** Server-side, `reviewed_at` cannot be
reset. Instead of compensating, the app buffers the *most recent*
decision locally and sends it only when the next one is made (or
the screen is left). That way exactly one step is guaranteed to be
undoable; older decisions have already reached the server and report that
honestly ("Rückgängig" (undo) disappears). If the app dies in the middle of the
session, at most one not-yet-sent decision is lost — the
group then stays unreviewed and shows up again later, i.e. the harmless
failure direction.

Permissions match the backend: loading requires `photos.view`, every
decision `photos.delete`. Without the latter the screen shows a notice
instead of the action bar.

**Header:**
- Counter "X offen" (X open)
- **"Alle hochkonfidenten bestätigen"** (confirm all high-confidence) with a disclaimer dialog: shows the top-1 hit rate from the per-user calibration (stage D) and requires a second click. If no calibration exists, the dialog points that out.
- Filter toggle All / Sicher (certain) / Mittel (medium) / Unsicher (uncertain).

**Pagination:** 30 cards per page, "Mehr laden" (load more) button (no infinite scroll because of card-height stability).

### Review dialog (`PhotoCompareView.vue`)

- **"KI-Vorschlag übernehmen"** (accept AI proposal) when the group has a pick → calls `POST /photos/groups/:id/accept-ai-pick` → hides every non-picked member via `photo_curation` (favorites protected). The group gets `reviewed_at` set.
- Once the compare view is closed **after** a real review, the gallery reloads automatically (`compareNeedsReload` flag). A pure dismiss (X / Esc) stays without a reload.

### Admin (Fotos › Einstellungen › Wartung, `PhotoMaintenanceView.vue`)

- **"Gruppen neu berechnen"** (recompute groups) — re-clustering (DINOv2 + pgvector). Implicitly triggers re-scoring.
- **"KI-Picks neu berechnen"** (recompute AI picks) — server-wide, all unreviewed groups with current weights.
- **"Alle hochkonfidenten KI-Picks bestätigen"** (confirm all high-confidence AI picks) — bulk apply, at the same time the default path without UI in the rapid-review view.
- **"Bildmaße nachtragen"** (backfill image dimensions) — one-time backfill for the orientation rule (no effect without dimensions).
- **"Kalibrierungs-Export herunterladen"** (download calibration export) — JSON with reviewed groups + sub-signals for offline analysis.
- **"KI auf meine Vorlieben kalibrieren"** — fits per-user weights; info message shows hit rate before/after the fit.

## Data model

### `photos`

| Column | Migration | Meaning |
|--------|-----------|---------|
| `ai_quality_score`     | 0003 | Composite score (0..1). |
| `ai_quality_details`   | 0004 | JSONB with sub-signals under the keys `sharpness`, `contrast`, `exposure`, `clip_aesthetics`, `clip_composition`, `clip_technical`, `face_sharpness`, `eyes_open`, `face_composition`. |
| `width` / `height`     | 0076 | Post-EXIF rotation. For orientation diversity. |

### `photo_groups`

| Column | Migration | Meaning |
|--------|-----------|---------|
| `ai_picked_photo_ids`  | 0075 | `INTEGER[]`. Multi-pick allowed (multi-pick threshold + orientation diversity). NULL = not scored. |
| `ai_picked_at`         | 0075 | Wall clock of the last scoring pass. |
| `ai_picked_confidence` | 0075 | `high` / `medium` / `low`. Drives the gallery filter. |
| `ai_pick_details`      | 0075 | JSONB. Per-photo score + sub-signals + `runner_up_delta`. |

`reviewed_at` (existing) takes precedence: AI picks are neither recomputed on reviewed groups nor applied in the gallery filter.

Partial index `photo_groups_ai_picked_active_idx` (migration 0075) on `(user_id) WHERE ai_picked_at IS NOT NULL AND reviewed_at IS NULL AND ai_picked_confidence = 'high'` — speeds up the frequent "should this photo be AI-hidden?" query.

### `ai_pick_user_weights` (migration 0079)

| Column | Meaning |
|--------|---------|
| `user_id`    | PK, FK → users. |
| `weights`    | JSONB: `{ face: number[7], non_face: number[5] }`. Both vectors sum to 1. |
| `fitted_at`  | Timestamp of the last fit. |
| `metadata`   | JSONB: pair counts + top-1 hit rate before/after the fit. |

## API endpoints (`photo/photo.ts`)

| Method | Path                                                  | Function |
|--------|-------------------------------------------------------|----------|
| `POST` | `/photos/find-groups`                                 | Re-clustering. Auto-recompute of the picks at the end. |
| `POST` | `/photos/groups/recompute-ai-picks`                   | Server-wide, re-score all unreviewed groups. |
| `POST` | `/photos/groups/:id/accept-ai-pick`                   | Accept the AI selection as a user review. |
| `POST` | `/photos/groups/:id/pick-photos`                      | Manual pick (stage C): keep `photoIds`, hide the rest. |
| `POST` | `/photos/groups/bulk-accept-ai-picks`                 | Bulk apply of all high-confidence groups. |
| `POST` | `/photos/groups/:id/accept-peer-consensus`            | Accept consensus from album peers (PR #416). |
| `GET`  | `/photos/groups/ai-pick-calibration`                  | Calibration export (JSON). Scores reviewed groups on demand. |
| `POST` | `/photos/groups/calibrate-ai-pick-weights`            | Fit per-user weights (stage D). |
| `GET`  | `/photos/groups/review-queue?offset=&limit=&confidence=` | Rapid-review stream + per-user calibration metadata + `peer_curation` aggregate per photo + filter-independent `high_confidence_total`. |
| `POST` | `/photos/backfill-dimensions`                         | Server-wide backfill of `width`/`height`. |

All admin endpoints require `data.manage`, the pick/accept endpoints `photos.delete`, the listing endpoints `photos.view`.

## Configuration knobs

All in `photo/group-auto-pick.ts`:

| Constant                   | Default | Meaning |
|----------------------------|---------|---------|
| `MULTI_PICK_THRESHOLD`     | 0.92    | Multi-pick cutoff relative to the top score. |
| `HIGH_CONFIDENCE_DELTA`    | 0.10    | Score gap for `high` → auto-hide. |
| `MEDIUM_CONFIDENCE_DELTA`  | 0.04    | Lower bound for `medium`. |
| `ORIENTATION_FLOOR`        | 0.75    | Floor for promotion via orientation diversity. |
| `REDUNDANCY_SIMILARITY`    | 0.97    | From this DINOv2 cosine on, two members count as the same shot. |
| `DIVERSITY_FLOOR`          | 0.85    | Minimum score (relative to the top) for a backfilling photo. |
| `SATURATION` (in `normaliseFaceCoverage`) | 0.30 | Face coverage saturates from 30%. |

`DEFAULT_SCORING_WEIGHTS` contains the defaults. In `group-auto-pick.calibration.ts`:

| Constant                   | Default | Meaning |
|----------------------------|---------|---------|
| `MIN_PAIRS_FOR_FIT`        | 10      | Minimum pairs per branch for persistence. |
| `DEFAULT_WEIGHTS`          | (see formula) | Identical to `DEFAULT_SCORING_WEIGHTS`. |

In `frontend/src/views/ReviewQueueView.vue`:

| Constant                   | Default | Meaning |
|----------------------------|---------|---------|
| `PAGE_SIZE`                | 30      | Cards per page. |
| `SMALL_GROUP_THRESHOLD`    | 3       | Up to this many members → one-click-pick layout. |
| `CONFIDENCE_BAR_MAX`       | 0.10    | Δ value for a full confidence bar (= `HIGH_CONFIDENCE_DELTA`). |

## Migrations

| # | Content |
|---|---------|
| 0075 | `photo_groups.ai_picked_*` + partial index. |
| 0076 | `photos.width` / `photos.height`. |
| 0077 | Reset stale picks (key-mapping bug `_score` vs. without). |
| 0078 | Reset stale picks (weight retuning + `face_composition`). |
| 0079 | `ai_pick_user_weights` for per-user calibration. |

## Brainstorming history

### Phase 1: Investigation brainstorming (issue #346)

Six approaches evaluated against each other:

| Approach | Accuracy | Performance @50k | Infrastructure | Decision |
|---|---|---|---|---|
| CLIP score | medium globally, flat within a burst | 0 (exists) | 0 | **Keep as global anchor** |
| BRISQUE | medium | ~50 min one-time | 1 dep | Deferred |
| Composition (rule/saliency) | low within a burst | 0–low | 0–1 model | Deferred |
| Face coverage/quality | high (burst discriminator) | 0 | 0 | **Adopted — strongest lever** |
| Sharpness/blur | high | 0 | 0 | **Adopted** |
| Local LLM (Llama-3.2-3B) | n/a (text-only) | n/a | high | Rejected |
| Local VLM (LLaVA) | medium–high | not practical on CPU | very high | Rejected |

→ Stage A: weighted linear combination of the existing signals, multi-pick + confidence gate.

### Phase 2: UX brainstorming (user feedback on auto-hide)

User plan:
- Store AI resolution separately from user review
- Auto-hide at high confidence; non-picks out of the grid
- Marker with group size (`+N`) on the cover; click opens review
- Filter toggle "KI-ausgeblendete anzeigen" analogous to "Ausgeblendete anzeigen"

My code review confirmed:
- Separation is clean (trust is preserved)
- Reversibility is good (toggle is only one click away)
- Risks: confidence threshold, marker discoverability, invalidation on re-grouping, fullscreen navigation, bulk apply, transitional state

→ PRs #402, #403, #408–#412 implement this with all risk mitigations.

### Phase 3: Brainstorming after the first calibration export

From the first real export (119 reviewed groups) it became visible that 75% of all groups land in `low` confidence → the AI only helps with 28% of the groups.

Twelve options (A–L) in the comment written at the time:

| # | Option | Status |
|---|--------|--------|
| A | Pairwise regression from user-override events | **DONE** — PR #413 (stage D) |
| B | MUSIQ / HyperIQA as an additional IQA signal | Open |
| C | VLM tiebreaker for uncertain groups (LLaVA-3B GGUF on CPU for ~5–10% of the groups) | Open |
| D | Recalibrate the `eyes_open` pipeline (CLIP → Mediapipe face landmarks) | Open |
| E | Re-validation with unseen data | Ongoing (user task) |
| F | Lower `HIGH_CONFIDENCE_DELTA` 0.10 → 0.15 | Open |
| G | Absolute hide threshold (score < 0.4) in addition to the relative one | Open |
| H | Lower `MULTI_PICK_THRESHOLD` 0.92 → 0.85 | Open |
| I | Built-in calibration-report endpoint (hit rates in the UI) | Partial — export exists, live stats missing |
| J | Automatic weight-regression pipeline | **DONE** — PR #413 |
| K | Re-score reviewed groups on trigger | Partial — `scoreReviewedGroupsForCalibration` runs inline during export (PR #405) |
| L | Implicit re-review marking on membership change | Partial — re-grouping invalidates unreviewed groups, reviewed ones remain (design decision) |

### Phase 4: Rapid-review UX brainstorming

Given the finding "53% of the groups are low and the AI does not help there at all", the UI lever was discussed. Four patterns:

| # | Idea | Status |
|---|------|--------|
| A | Bulk-accept strip (vertical card list) | **DONE** — PR #414 |
| B | Keyboard-driven walk (one photo/screen + shortcuts) | Open |
| C | One-click pick for 2-/3-photo groups | **DONE** — PR #414 |
| D | Hybrid A + confidence sorting + disclaimer | **DONE** — PR #414 |

### Phase 5: UX consolidation + peer curation (PR #416)

After the first live test of the rapid review, several UX findings were addressed:

- **Consolidation**: duplicate entry points cleared away — the "Gruppen bearbeiten" (edit groups) button in the gallery header and the bulk-accept button in photo maintenance were redundant to the new review queue. Naming unified to "Sicher" / "Alle Sicheren bestätigen" (confirm all certain ones).
- **Lightbox**: strip thumbs are too small (~80 px) for real assessment. Tap opens full-screen; click anywhere closes.
- **AI-pick marking in the compare view**: tile with `isAiPicked()` gets a green chip — visible what the AI would keep.
- **`singleGroupMode` prop**: compare view from the queue shows no "Fertig + Weiter" (done + next) — closing returns to the queue.
- **"Alle wählen" (select all) action**: third card button — marks the group as reviewed without hiding anything. Use case: intentional burst series.

**Peer curation from shared albums** (big lever):

| # | Phase | Status |
|---|-------|--------|
| 1 | Make visible — `peer_curation: { hidden, favorite }` per photo in the response, small corner badges on the strip thumb | **DONE** — PR #416 |
| 2 | "Konsens übernehmen" (accept consensus) — one-click acceptance of the conservative majority decision | **DONE** — PR #416 |
| 3 | Trusted-reviewer cascade — opt-in auto-sync between trusted users | Open, depends on experience with phases 1+2 |

**Privacy boundary**: aggregate query with a double EXISTS subquery — a peer signal only counts if peer **and** requester currently share at least one album that contains the photo. Own curation rows excluded.

**Consensus rule** (conservative): a photo is only hidden if ≥1 peer has hidden it **and** 0 peers have favorited it. The requester's own favorite is never clobbered (same ON CONFLICT guard as `acceptAiPickLogic`).

## Known weaknesses + open options

### Weaknesses

1. **`eyes_open` is weak**: range in the user sample only 0.35–0.67 (`std 0.07`). Should be bimodal (eyes open ≈ 0.85, eyes closed ≈ 0.15). Possibly a conservative CLIP prompt or badly trained for people bursts. **Mitigation:** `face_composition` (0.10) and `face_sharpness` (0.40) already dominate; eyes_open carries only 0.20.

2. **Burst discrimination breaks down**: within a burst, 5 of 9 signals are quasi-constant (same scene, camera, exposure). Real discriminators are `face_sharpness`, `face_coverage`, `eyes_open`, `face_composition`. For non-people bursts there is no strong signal — this explains the high `low` rate.

3. **Auto-hide is not "kept ⊆ pick"-perfect**: in the sample, high confidence had only 38% kept⊆pick. Tendency: the user keeps more photos per burst than the AI. **Mitigation:** toggle "KI-ausgeblendete anzeigen" + one-click pick + per-user calibration. Should ease with stage D (PR #413).

4. **Multi-user workload**: with several users on the same server, each user gets their own weights. Backfill / recompute / bulk apply are explicitly server-wide, other operations per user.

### Open options (priority, sorted by expected leverage)

#### Low-hanging
- **D (replace eyes_open)**: Mediapipe face landmarks → eye aspect ratio. A truly bimodal signal. Would significantly improve burst tiebreaking for portraits. Effort: 1 PR in `embedding_service` + re-scan. Low risk — only one signal gets better.
- **F/G/H (threshold tuning)**: after the next calibration export, assess whether the current defaults are too conservative/aggressive. Turning a constant is trivial.
- **I (calibration-report endpoint)**: `GET /photos/groups/ai-pick-stats` with current hit rates per confidence level + distributions. Card under Fotos › Einstellungen › Wartung, updated daily. Effort: ~1 PR.

#### Medium
- **B from phase 4 (keyboard walk)**: power-user mode for the review-queue view. One card per screen, space = accept, ↑ = skip, Enter = manual. 1 second per group feasible.
- **B from phase 3 (MUSIQ / HyperIQA)**: additional IQA signal in the quality pipeline. ~5 h initial compute on CPU. Would strengthen non-people bursts, where there is currently little discrimination information.

#### High
- **C from phase 3 (VLM tiebreaker)**: LLaVA-3B GGUF in the `llm-service` only for groups with `runner_up_delta < 0.05`. About 5–10% of the groups. CPU-feasible because selective. Effort: new model pull, vision endpoint, prompt engineering — substantial.
- **Stage-D auto-recalibrate**: after N new user reviews, automatically trigger a new fit. Saves manual clicks. Prerequisite: observing the effect over several weeks.

## Session history (as of the track-I rollout)

15 pull requests in this iteration:

| PR | Content |
|----|---------|
| #402 | Initial track-I stack: migration 0075, scoring, multi-pick, confidence, find-groups integration, endpoints, marker UX in the grid, filter toggle, compare-dialog button, admin buttons |
| #403 | Orientation diversity + width/height (migration 0076) |
| #404 | Backfill + recompute server-wide (instead of user-scoped) |
| #405 | Calibration export scores reviewed groups inline |
| #406 | Fix DB key mapping (sharpness/contrast/exposure/eyes_open) + reset stale state (migration 0077) |
| #407 | `face_composition` signal + initial doc `documentation/ai-auto-pick.md` (migration 0078) |
| #408 | Click semantics in PhotoGrid (accidentally fixed the wrong component) |
| #409 | Hidden-siblings marker in grid + fullscreen, URL-sync fix, filter persistence |
| #410 | Track-I marker in **VirtualGallery** (the real gallery) + PhotoGrid.vue deleted (dead code) |
| #411 | Three bugs in the filter-toggle pipeline (URL round-trip race, partial-page init marker, scroll anchor) |
| #412 | Soft reload after review (hidden photos disappear from the grid) |
| #413 | **Stage D**: per-user pairwise regression (migration 0079) |
| #414 | **Stage A + D + C**: rapid-review view, confidence bar, bulk disclaimer, one-click pick (open during doc update) |

Plus two bonus insights from the session:
- **PhotoGrid.vue was dead code.** It was accidentally touched in PRs #408 and #409 instead of VirtualGallery. Removed with #410.
- **eyes_open is weak in the user's existing data**, because the user had already sorted out blink frames manually. For new uploads the signal should be meaningful again.

## Relevant source files

Backend:
- `photo/group-auto-pick.ts` — pure scoring logic (no DB access)
- `photo/group-auto-pick.service.ts` — DB aggregation + persistence + review queue + accept flow
- `photo/group-auto-pick.calibration.ts` — pairwise logistic regression
- `photo/group-auto-pick.test.ts` — unit tests of the scoring logic
- `photo/group-auto-pick.service.test.ts` — integration tests with DB
- `photo/group-auto-pick.calibration.test.ts` — regression math + feature-vector helpers
- `photo/photo.service.ts` — `findPhotoGroupsLogic`, `backfillPhotoDimensionsLogic`, wiring to `findGroups`
- `photo/photo.ts` — REST endpoints
- `photo/photo.filters.ts` — `aiHiddenMode` filter clause
- `photo/gallery-grid.service.ts` — surface of the pick info per grid cell
- `db/schema.ts` — `photoGroups.ai_picked_*` + `aiPickUserWeights`

Frontend:
- `frontend/src/api/photos.ts` — API client wrapper for all AI-pick endpoints
- `frontend/src/api/gallery.ts` — `GalleryGridGroup` with `ai_picked` / `ai_confidence`
- `frontend/src/views/GalleryView.vue` — main gallery, wiring of compare dialog + soft reload
- `frontend/src/views/ReviewQueueView.vue` — **rapid-review UI** (stage A + C + D)
- `frontend/src/components/admin/PhotoGroupingPanel.vue` — admin buttons (Fotos › Einstellungen › Wartung)
- `frontend/src/components/VirtualGallery.vue` — marker rendering in the main grid
- `frontend/src/components/FullscreenOverlay.vue` — fullscreen marker
- `frontend/src/components/FilterMenu.vue` — "KI-ausgeblendete anzeigen" toggle
- `frontend/src/components/PhotoCompareView.vue` — "KI-Vorschlag übernehmen" button
- `frontend/src/composables/useFilter.ts` — URL sync incl. `showAiHidden`
- `frontend/src/composables/useGallerySource.ts` — sparse page cache with corrected partial-page marking
- `frontend/src/config/modules.ts` — route + menu entry for `/fotos/review-queue`

iOS (SwiftUI, issue #761):
- `ios/Sources/FKPhotos/Features/Review/ReviewQueueModels.swift` — wire types of the
  review queue, decision kinds, swipe→decision mapping and the
  cursor/undo buffer (`ReviewQueueState`)
- `ios/Sources/FKPhotos/Features/Review/ReviewQueueViewModel.swift` — loading,
  pagination, serialized commit chain
- `ios/Sources/FKPhotos/Features/Review/ReviewQueueView.swift` — card UI with
  swipe gestures and equivalent buttons
- `ios/Sources/FKPhotos/Features/Review/ReviewPhotoPreview.swift` — zoomable
  large view of the group members with the labeled „Nur dieses Foto
  behalten" button
- `ios/Sources/FKPhotos/Features/Review/ReviewSelectionSheet.swift` — manual
  overriding of the AI proposal (thumbs up/down per photo, local until
  commit)
- `ios/Sources/FKPhotos/Features/Feed/FeedView.swift` — entry point in the
  feed toolbar
- `ios/Tests/FKPhotosTests/ReviewQueueTests.swift` — tests for mapping + undo

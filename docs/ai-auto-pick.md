# AI Auto-Pick: Best-of-Group für ähnliche Foto-Gruppen

## Summary

Track I der Photo-Organisation (Issues [#358](https://github.com/as19git67/fk-encore/issues/358) / [#346](https://github.com/as19git67/fk-encore/issues/346)). Bei 50 k+ Fotos entstehen über die DINOv2-Ähnlichkeitssuche typischerweise 5 k+ Similar-Groups. Manuelles Review ist nicht skalierbar. Die KI bewertet jede Gruppe anhand bereits vorhandener Per-Foto-Signale, schlägt einen "Best-of-Group"-Pick vor (oder mehrere bei knapper Entscheidung) und versteckt die übrigen Fotos hinter einem Marker. Der User kann den Vorschlag übernehmen, ignorieren oder per Toggle übersteuern.

**User-Entscheidungen haben immer Vorrang** — die KI fasst reviewte Gruppen nicht mehr an.

## Pipeline

```
                     ┌──────────────────────────────────────────┐
                     │  embedding_service (Python)              │
                     │   • DINOv2 Embeddings → pgvector         │
                     │   • Quality-Scorer schreibt nach         │
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
        │   • findPhotoGroupsLogic – clustert via pgvector   │
        │     → photo_groups, photo_group_members            │
        │   • Am Ende: recomputeAiPicksForUser() scort alle  │
        │     unreviewten Gruppen                            │
        │   • backfillPhotoDimensionsLogic – einmaliger      │
        │     width/height-Seed via sharp().rotate()         │
        └──────────────────┬─────────────────────────────────┘
                           │
                           ▼
        ┌────────────────────────────────────────────────────┐
        │  group-auto-pick.service.ts                        │
        │   • loadSignalsForPhotos – ein Query pro Batch     │
        │   • Aggregiert face_coverage aus faces.bbox        │
        │   • Klassifiziert orientation aus photos.width/.h  │
        │   • Lädt per-User-Gewichte aus                     │
        │     ai_pick_user_weights, fällt auf Defaults zurück│
        │   • Persistiert in photo_groups.ai_pick_details    │
        └──────────────────┬─────────────────────────────────┘
                           │
                           ▼
        ┌────────────────────────────────────────────────────┐
        │  group-auto-pick.ts (pure logic, kein DB-Zugriff)  │
        │   • scorePhoto – Linearkombination der Signale     │
        │   • computeGroupPick – Multi-Pick + Confidence     │
        │     + Orientation-Diversität                       │
        └────────────────────────────────────────────────────┘
                           │
                           ▼
        ┌────────────────────────────────────────────────────┐
        │  group-auto-pick.calibration.ts                    │
        │   • fitPairwiseWeights – Logistic-Regression       │
        │     über die User-Reviews                          │
        │   • Persistiert auf ai_pick_user_weights           │
        └────────────────────────────────────────────────────┘
```

## Scoring-Formel

Pro Foto wird ein Score in [0, 1] berechnet. Branch je nachdem ob mindestens ein Gesicht detektiert wurde. Gewichte werden zur Laufzeit aus `ai_pick_user_weights` geladen — wenn keine Kalibrierung existiert, gelten die Defaults unten.

### Face-Branch (`faces.count > 0`) — Default-Gewichte

| Signal              | Default | Quelle |
|---------------------|---------|--------|
| `face_sharpness`    | 0.40    | `ai_quality_details.face_sharpness` |
| `eyes_open`         | 0.20    | `ai_quality_details.eyes_open` |
| `face_coverage`     | 0.15    | Σ(`faces.bbox.width · height`), saturiert bei 30 % |
| `face_composition`  | 0.10    | `ai_quality_details.face_composition` |
| `sharpness` (global)| 0.05    | `ai_quality_details.sharpness` |
| `clip_aesthetics`   | 0.05    | `ai_quality_details.clip_aesthetics` |
| `exposure+contrast` | 0.05    | 0.5 · (`exposure` + `contrast`) |

### Non-Face-Branch — Default-Gewichte

| Signal              | Default | Quelle |
|---------------------|---------|--------|
| `sharpness`         | 0.40    | `ai_quality_details.sharpness` |
| `clip_aesthetics`   | 0.25    | `ai_quality_details.clip_aesthetics` |
| `clip_composition`  | 0.15    | `ai_quality_details.clip_composition` |
| `clip_technical`    | 0.10    | `ai_quality_details.clip_technical` |
| `exposure+contrast` | 0.10    | 0.5 · (`exposure` + `contrast`) |

Fehlende Einzelsignale werden auf neutral 0.5 gemappt (`clamp01`), damit ein Foto mit unvollständiger Qualitäts-Bewertung weder bestraft noch belohnt wird.

## Per-User-Kalibrierung (Stufe D)

Lernt aus den bereits reviewten Gruppen welche Signale dem User wichtig sind.

**Pairwise logistic regression** über kept-vs-hidden-Paare innerhalb reviewter Gruppen:
- Pro reviewter Gruppe: für jedes Paar (kept, hidden) wird ein Feature-Diff gebildet
- Face- und Non-Face-Branch werden getrennt fittiert
- Vanilla gradient descent: 600 iters, lr 0.10, positive Clipping + Sum-to-1-Normalisierung pro Schritt
- Persistenz auf `ai_pick_user_weights`

Safeguard `MIN_PAIRS_FOR_FIT` (10): Branches mit zu wenig Daten behalten die Defaults — ein halbtrainierter User soll nicht den anderen Branch verschlechtern.

Trigger: Button **"KI auf meine Vorlieben kalibrieren"** in der `DataManagementView`. Nach einem Fit zeigt der Server pro Branch die Top-1-Trefferquote vor/nach dem Fit (Vergleich gegen die Defaults), die UI rendert das als Info-Message.

Reversibel: `DELETE FROM ai_pick_user_weights WHERE user_id = X` stellt die Defaults wieder her.

## Multi-Pick und Confidence

```
ranked = photos.sort by score desc
top    = ranked[0]
cutoff = top.score · MULTI_PICK_THRESHOLD  (Default 0.92)
picks  = { p ∈ ranked : p.score ≥ cutoff }

Δ = top.score − bestNonPick.score   (oder 0, falls alle gepickt)

confidence =
   "high"   if Δ ≥ HIGH_CONFIDENCE_DELTA    (0.10)
   "medium" if Δ ≥ MEDIUM_CONFIDENCE_DELTA  (0.04)
   "low"    sonst
```

**Orientation-Diversität:** Enthält die Gruppe gleichzeitig Portrait- und Landscape-Fotos derselben Szene, wird zusätzlich pro vorhandener Orientierung das jeweils beste Foto gepickt — sofern es mindestens `ORIENTATION_FLOOR · top.score` (0.75) erreicht. Square-Fotos werden ignoriert.

## UX

### Galerie (`VirtualGallery.vue`)

- **`high` Confidence:** Nicht-Picks werden im Grid automatisch versteckt (Server-Filter `aiHiddenMode=exclude`). User sieht nur den Pick, mit `+N`-Marker am Cover.
- **`medium`:** Marker mit Orange-Tint, kein Auto-Hide.
- **`low`:** Marker neutral, kein Auto-Hide.

Klick-Semantik im Grid:
- **Klick aufs Foto** → Fullscreen-Ansicht (auch bei Gruppen-Mitgliedern)
- **Klick auf den `+N`-Marker** → Review-Dialog (`PhotoCompareView`)
- **Ctrl/Cmd/Shift-Klick** → Multi-Select der ganzen Gruppe

Im **Fullscreen** wird derselbe `+N`-Marker oben links eingeblendet, mit `pi-eye-slash`-Icon bei high-confidence-versteckten Geschwistern. Tap → Review-Dialog.

**Filter-Toggle "KI-ausgeblendete anzeigen"** in `FilterMenu.vue` neben "Ausgeblendete anzeigen". Aktiv → Server-Filter wird zu `aiHiddenMode=include` → alle KI-versteckten Fotos werden wieder sichtbar, Marker bleibt.

### Rapid Review (`/fotos/review-queue`)

Eigene Route + Menüeintrag "Gruppen-Review". Vertikale Karten-Liste, sortiert high → medium → low → no-pick, innerhalb gleicher Stufe nach Gruppengröße absteigend.

**Per Karte:**
- Confidence-Chip + **Confidence-Bar** (visualisiert Δ zum Runner-up; 0.10 = volle Bar)
- Bei **≤ 3 Mitgliedern (Stufe C):** alle Fotos side-by-side gleich groß. Ein Klick auf ein Foto = "dieses behalten, Rest verstecken, reviewt". KI-Vorschlag bekommt grüne Outline + Check-Icon, ist aber kein Pflicht-Pick.
- Bei **4+ Mitgliedern:** KI-Pick groß + Sibling-Strip mit gedimmten Nicht-Picks.
- Action-Bar: **"KI-Pick übernehmen"** (atomar) + **"Manuell prüfen"** (öffnet `PhotoCompareView` für volle Granularität).

### Rapid Review auf iOS (Wisch-Variante)

Die iOS-App konsumiert dieselbe `/photos/groups/review-queue` und dieselben
Aktions-Endpoints, präsentiert sie aber als **Karten-Stapel statt Liste** — eine
Gruppe pro Karte, aufgelöst mit einer einzigen Geste:

| Geste | Aktion | Endpoint |
|---|---|---|
| → rechts | KI-Vorschlag übernehmen | `POST /photos/groups/:id/accept-ai-pick` |
| ← links | Alle behalten, nur als geprüft markieren | `POST /photos/groups/:id/review` |
| ↑ hoch | Vorschlag favorisieren **und** übernehmen | `PATCH /photos/:id/curation` + accept-ai-pick |
| Tippen auf ein Foto | Großansicht öffnen (keine Entscheidung) | — |
| „Nur dieses Foto behalten" in der Großansicht bzw. Kontextmenü | Nur dieses behalten | `POST /photos/groups/:id/pick-photos` |
| Button (bei Peer-Signal) | Konsens übernehmen | `POST /photos/groups/:id/accept-peer-consensus` |

Jede Wischgeste hat einen gleichwertigen Button — eine reine Gestenoberfläche
wäre mit VoiceOver / Switch Control nicht bedienbar.

**Antippen entscheidet bewusst nichts.** In der ersten Fassung löste ein Tap
auf ein Thumbnail die Gruppe auf ("nur dieses behalten"). In der Praxis tippt
man aber, um das Foto *größer zu sehen* und die Details überhaupt beurteilen zu
können — Geste und Konsequenz zeigten in entgegengesetzte Richtungen, und ein
Fehltipp blendete den Rest der Gruppe aus. Der Tap öffnet deshalb
`ReviewPhotoPreview`: das vollständige Bild (nicht das Thumbnail), zoombar und
zwischen den Gruppenmitgliedern blätterbar. Das Behalten eines einzelnen Fotos
ist dort ein beschrifteter Button, der die Konsequenz mitschreibt ("Die anderen
3 Fotos werden ausgeblendet"), zusätzlich erreichbar über das Kontextmenü der
Kachel und eine VoiceOver-Aktion.

**Die Hoch-Wischgeste ist keine reine Favoriten-Markierung.** Sie favorisiert
den KI-Vorschlag *und* löst die Gruppe auf wie die Rechts-Geste. Label und
Hinweistext schreiben beide Hälften aus ("Favorit & übernehmen"), weil eine
Aktion mit zwei Wirkungen sonst nur durch Ausprobieren zu lernen wäre.

**Gruppen ohne KI-Vorschlag** lassen sich per Wischgeste grundsätzlich nur
"behalten": `pick-photos` verlangt eine nicht-leere Keep-Menge, und alle
Mitglieder auszublenden wäre eine destruktive Überraschung. Solche Gruppen
werden über die Großansicht bzw. das Kontextmenü aufgelöst.

**Undo ohne Un-Review-Endpoint.** Serverseitig lässt sich `reviewed_at` nicht
zurücksetzen. Statt zu kompensieren puffert die App die *jeweils neueste*
Entscheidung lokal und sendet sie erst, wenn die nächste getroffen wird (oder
der Screen verlassen wird). Damit ist genau ein Schritt garantiert
zurücknehmbar; ältere Entscheidungen sind bereits beim Server und melden das
auch ehrlich zurück ("Rückgängig" verschwindet). Stirbt die App mitten in der
Sitzung, geht höchstens eine noch nicht gesendete Entscheidung verloren — die
Gruppe bleibt dann ungeprüft und taucht später wieder auf, also die harmlose
Fehlerrichtung.

Berechtigungen entsprechen dem Backend: Laden braucht `photos.view`, jede
Entscheidung `photos.delete`. Ohne die zweite zeigt der Screen einen Hinweis
statt der Aktionsleiste.

**Header:**
- Counter "X offen"
- **"Alle hochkonfidenten bestätigen"** mit Disclaimer-Dialog: zeigt die Top-1-Trefferquote aus der Per-User-Kalibrierung (Stufe D) und verlangt einen zweiten Klick. Wenn keine Kalibrierung existiert, weist der Dialog darauf hin.
- Filter-Toggle Alle / Sicher / Mittel / Unsicher.

**Pagination:** 30 Karten pro Page, "Mehr laden"-Button (kein Infinite-Scroll wegen Card-Höhen-Stabilität).

### Review-Dialog (`PhotoCompareView.vue`)

- **"KI-Vorschlag übernehmen"** wenn die Gruppe einen Pick hat → ruft `POST /photos/groups/:id/accept-ai-pick` → hidet jedes Nicht-Picked-Mitglied via `photo_curation` (Favoriten geschützt). Group wird `reviewed_at` gesetzt.
- Sobald die Compare-View zugemacht wird **nach** einem echten Review, lädt die Galerie automatisch nach (`compareNeedsReload`-Flag). Pure Dismiss (X / Esc) bleibt ohne Reload.

### Admin (`DataManagementView.vue`)

- **"Gruppen neu berechnen"** — Re-Clustering (DINOv2 + pgvector). Triggert implizit Re-Scoring.
- **"KI-Picks neu berechnen"** — server-weit alle unreviewten Gruppen mit aktuellen Gewichten.
- **"Alle hochkonfidenten KI-Picks bestätigen"** — Bulk-Apply, gleichzeitig der Default-Pfad ohne UI im Rapid-Review-View.
- **"Bildmaße nachtragen"** — einmaliger Backfill für die Orientation-Regel (ohne Maße kein Effekt).
- **"Kalibrierungs-Export herunterladen"** — JSON mit reviewten Gruppen + Sub-Signalen für Offline-Analyse.
- **"KI auf meine Vorlieben kalibrieren"** — fittiert per-User-Gewichte; Info-Message zeigt Trefferquote vor/nach Fit.

## Datenmodell

### `photos`

| Spalte | Migration | Bedeutung |
|--------|-----------|-----------|
| `ai_quality_score`     | 0003 | Composite-Score (0..1). |
| `ai_quality_details`   | 0004 | JSONB mit Sub-Signalen unter den Keys `sharpness`, `contrast`, `exposure`, `clip_aesthetics`, `clip_composition`, `clip_technical`, `face_sharpness`, `eyes_open`, `face_composition`. |
| `width` / `height`     | 0076 | Post-EXIF-Rotation. Für Orientation-Diversität. |

### `photo_groups`

| Spalte | Migration | Bedeutung |
|--------|-----------|-----------|
| `ai_picked_photo_ids`  | 0075 | `INTEGER[]`. Multi-Pick erlaubt (Multi-Pick-Threshold + Orientation-Diversität). NULL = nicht gescort. |
| `ai_picked_at`         | 0075 | Wall-Clock des letzten Scoring-Passes. |
| `ai_picked_confidence` | 0075 | `high` / `medium` / `low`. Treibt den Gallery-Filter. |
| `ai_pick_details`      | 0075 | JSONB. Per-Foto Score + Sub-Signale + `runner_up_delta`. |

`reviewed_at` (bestehend) hat Vorrang: KI-Picks werden auf reviewten Gruppen weder neu berechnet noch im Gallery-Filter angewandt.

Partial-Index `photo_groups_ai_picked_active_idx` (Migration 0075) auf `(user_id) WHERE ai_picked_at IS NOT NULL AND reviewed_at IS NULL AND ai_picked_confidence = 'high'` — beschleunigt die häufige "soll dieses Foto AI-hidden werden?"-Query.

### `ai_pick_user_weights` (Migration 0079)

| Spalte | Bedeutung |
|--------|-----------|
| `user_id`    | PK, FK → users. |
| `weights`    | JSONB: `{ face: number[7], non_face: number[5] }`. Beide Vektoren summieren zu 1. |
| `fitted_at`  | Timestamp des letzten Fits. |
| `metadata`   | JSONB: Pair-Counts + Top-1-Trefferquote vor/nach Fit. |

## API-Endpoints (`photo/photo.ts`)

| Method | Path                                                  | Funktion |
|--------|-------------------------------------------------------|----------|
| `POST` | `/photos/find-groups`                                 | Re-Clustering. Auto-Recompute der Picks am Ende. |
| `POST` | `/photos/groups/recompute-ai-picks`                   | Server-weit, alle unreviewten Gruppen neu scoren. |
| `POST` | `/photos/groups/:id/accept-ai-pick`                   | KI-Auswahl als User-Review übernehmen. |
| `POST` | `/photos/groups/:id/pick-photos`                      | Manueller Pick (Stufe C): keep `photoIds`, hide rest. |
| `POST` | `/photos/groups/bulk-accept-ai-picks`                 | Bulk-Apply aller hochkonfidenten Gruppen. |
| `POST` | `/photos/groups/:id/accept-peer-consensus`            | Konsens aus Album-Peers übernehmen (PR #416). |
| `GET`  | `/photos/groups/ai-pick-calibration`                  | Kalibrierungs-Export (JSON). Scort reviewte Gruppen on-demand. |
| `POST` | `/photos/groups/calibrate-ai-pick-weights`            | Fit per-User-Gewichte (Stufe D). |
| `GET`  | `/photos/groups/review-queue?offset=&limit=&confidence=` | Rapid-Review-Stream + Per-User-Calibration-Metadaten + `peer_curation`-Aggregat pro Foto + filter-unabhängige `high_confidence_total`. |
| `POST` | `/photos/backfill-dimensions`                         | Server-weiter Backfill von `width`/`height`. |

Alle Admin-Endpoints benötigen `data.manage`, die Pick/Accept-Endpoints `photos.delete`, die Listing-Endpoints `photos.view`.

## Konfigurations-Knobs

Alles in `photo/group-auto-pick.ts`:

| Konstante                  | Default | Bedeutung |
|----------------------------|---------|-----------|
| `MULTI_PICK_THRESHOLD`     | 0.92    | Multi-Pick-Cutoff relativ zum Top-Score. |
| `HIGH_CONFIDENCE_DELTA`    | 0.10    | Score-Abstand für `high` → Auto-Hide. |
| `MEDIUM_CONFIDENCE_DELTA`  | 0.04    | Untere Grenze für `medium`. |
| `ORIENTATION_FLOOR`        | 0.75    | Floor für Promotion via Orientation-Diversität. |
| `SATURATION` (in `normaliseFaceCoverage`) | 0.30 | Face-Coverage saturiert ab 30 %. |

`DEFAULT_SCORING_WEIGHTS` enthält die Defaults. In `group-auto-pick.calibration.ts`:

| Konstante                  | Default | Bedeutung |
|----------------------------|---------|-----------|
| `MIN_PAIRS_FOR_FIT`        | 10      | Minimum-Paare pro Branch für Persistenz. |
| `DEFAULT_WEIGHTS`          | (s. Formel) | Identisch zu `DEFAULT_SCORING_WEIGHTS`. |

In `frontend/src/views/ReviewQueueView.vue`:

| Konstante                  | Default | Bedeutung |
|----------------------------|---------|-----------|
| `PAGE_SIZE`                | 30      | Karten pro Page. |
| `SMALL_GROUP_THRESHOLD`    | 3       | Bis zu so viele Mitglieder → One-Click-Pick-Layout. |
| `CONFIDENCE_BAR_MAX`       | 0.10    | Δ-Wert für volle Confidence-Bar (= `HIGH_CONFIDENCE_DELTA`). |

## Migrations

| # | Inhalt |
|---|--------|
| 0075 | `photo_groups.ai_picked_*` + Partial-Index. |
| 0076 | `photos.width` / `photos.height`. |
| 0077 | Reset stale picks (Key-Mapping-Bug `_score` vs. ohne). |
| 0078 | Reset stale picks (Gewichts-Retuning + `face_composition`). |
| 0079 | `ai_pick_user_weights` für Per-User-Kalibrierung. |

## Brainstorming-Historie

### Phase 1: Investigations-Brainstorming (Issue #346)

Sechs Ansätze gegeneinander bewertet:

| Ansatz | Genauigkeit | Performance @50k | Infrastruktur | Entscheidung |
|---|---|---|---|---|
| CLIP-Score | mittel global, flach in Burst | 0 (vorhanden) | 0 | **Behalten als globaler Anker** |
| BRISQUE | mittel | ~50 min one-time | 1 Dep | Zurückgestellt |
| Composition (rule/saliency) | niedrig in Burst | 0–niedrig | 0–1 Modell | Zurückgestellt |
| Face-Coverage/-Quality | hoch (Burst-Diskriminator) | 0 | 0 | **Übernommen — Stärkster Hebel** |
| Sharpness/Blur | hoch | 0 | 0 | **Übernommen** |
| Lokales LLM (Llama-3.2-3B) | n/a (text-only) | n/a | hoch | Verworfen |
| Lokales VLM (LLaVA) | mittel–hoch | nicht praktikabel CPU | sehr hoch | Verworfen |

→ Stufe A: gewichtete Linearkombination aus den bestehenden Signalen, Multi-Pick + Confidence-Gate.

### Phase 2: UX-Brainstorming (User-Feedback zum Auto-Hide)

User-Plan:
- AI-Resolution separat von User-Review speichern
- Auto-Hide bei high-Confidence; Nicht-Picks aus Grid raus
- Marker mit Gruppengröße (`+N`) am Cover; Klick öffnet Review
- Filter-Toggle "KI-ausgeblendete anzeigen" analog zu "Ausgeblendete anzeigen"

Mein Code-Review bestätigte:
- Trennung sauber (Trust bleibt)
- Reversibilität gut (Toggle ist nur einen Klick entfernt)
- Risiken: Confidence-Schwelle, Marker-Discoverability, Invalidation bei Re-Grouping, Fullscreen-Navigation, Bulk-Apply, Übergangszustand

→ PRs #402, #403, #408–#412 setzen das mit allen Risiko-Mitigationen um.

### Phase 3: Brainstorming nach erstem Kalibrierungs-Export

Aus dem ersten echten Export (119 reviewte Gruppen) wurde sichtbar dass 75 % aller Gruppen in `low` Confidence landen → die KI hilft nur bei 28 % der Gruppen.

Zwölf Optionen (A–L) im damals erstellten Kommentar:

| # | Option | Status |
|---|---|---|
| A | Pairwise-Regression aus User-Override-Events | **DONE** — PR #413 (Stufe D) |
| B | MUSIQ / HyperIQA als zusätzliches IQA-Signal | Offen |
| C | VLM-Tiebreaker für unsichere Gruppen (LLaVA-3B GGUF auf CPU für ~5–10 % der Gruppen) | Offen |
| D | `eyes_open` Pipeline neu kalibrieren (CLIP → Mediapipe Face-Landmarks) | Offen |
| E | Re-Validierung mit ungesehenem Bestand | Laufend (User-Aufgabe) |
| F | `HIGH_CONFIDENCE_DELTA` 0.10 → 0.15 senken | Offen |
| G | Absolute Hide-Schwelle (score < 0.4) zusätzlich zur relativen | Offen |
| H | `MULTI_PICK_THRESHOLD` 0.92 → 0.85 senken | Offen |
| I | Eingebauter Calibration-Report-Endpoint (Trefferquoten in der UI) | Teilweise — Export existiert, Live-Stats fehlen |
| J | Automatische Gewichts-Regression-Pipeline | **DONE** — PR #413 |
| K | Re-Score reviewter Gruppen auf Trigger | Teilweise — `scoreReviewedGroupsForCalibration` läuft inline beim Export (PR #405) |
| L | Implizite Re-Review-Markierung bei Membership-Change | Teilweise — Re-Grouping invalidiert unreviewte Gruppen, reviewte bleiben (Design-Entscheidung) |

### Phase 4: Rapid-Review-UX-Brainstorming

Auf den Befund "53 % der Gruppen sind low und die KI hilft dort gar nicht" wurde der UI-Hebel diskutiert. Vier Patterns:

| # | Idee | Status |
|---|---|---|
| A | Bulk-Accept-Strip (vertikale Karten-Liste) | **DONE** — PR #414 |
| B | Keyboard-Driven Walk (ein Foto/Bildschirm + Shortcuts) | Offen |
| C | One-Click-Pick für 2-/3-Photo-Gruppen | **DONE** — PR #414 |
| D | Hybrid A + Confidence-Sortierung + Disclaimer | **DONE** — PR #414 |

### Phase 5: UX-Konsolidierung + Peer-Curation (PR #416)

Nach dem ersten Live-Test der Rapid-Review wurden mehrere UX-Findings adressiert:

- **Konsolidierung**: doppelte Einstiege weggeräumt — der "Gruppen bearbeiten"-Button im Gallery-Header und der Bulk-Accept-Button in der Datenverwaltung waren redundant zur neuen Review-Queue. Naming auf "Sicher" / "Alle Sicheren bestätigen" vereinheitlicht.
- **Lightbox**: Strip-Thumbs sind zu klein (~80 px) zur echten Beurteilung. Tap öffnet Bildschirmfüllend; Klick irgendwo schließt.
- **KI-Pick-Markierung im Compare-View**: Tile mit `isAiPicked()` bekommt grünes Chip — sichtbar, was die KI behalten würde.
- **`singleGroupMode`-Prop**: Compare-View aus der Queue zeigt kein "Fertig + Weiter" — schließen kehrt zur Queue zurück.
- **"Alle wählen"-Aktion**: dritter Card-Button — markiert Gruppe als reviewt ohne irgendetwas auszublenden. Use Case: absichtliche Burst-Reihen.

**Peer-Curation aus geteilten Alben** (großer Hebel):

| # | Phase | Status |
|---|---|---|
| 1 | Sichtbarmachen — `peer_curation: { hidden, favorite }` pro Foto in der Response, kleine Eck-Badges am Strip-Thumb | **DONE** — PR #416 |
| 2 | "Konsens übernehmen" — Ein-Klick-Übernahme der konservativen Mehrheits-Entscheidung | **DONE** — PR #416 |
| 3 | Trusted-Reviewer-Cascade — Opt-in-Auto-Sync zwischen vertrauten Usern | Offen, abhängig von Phase 1+2-Erfahrungen |

**Privacy-Boundary**: Aggregat-Query mit doppelter EXISTS-Subquery — ein Peer-Signal zählt nur, wenn Peer **und** Requester aktuell mindestens ein Album teilen, das das Foto enthält. Eigene Curation-Rows ausgeschlossen.

**Konsens-Regel** (konservativ): Foto wird nur ausgeblendet, wenn ≥1 Peer es hidden hat **und** 0 Peers es favorisiert haben. Eigener Favorit des Requesters wird niemals clobbered (gleiche ON CONFLICT-Guard wie `acceptAiPickLogic`).

## Bekannte Schwächen + offene Optionen

### Schwächen

1. **`eyes_open` ist schwach**: Range im User-Sample nur 0.35–0.67 (`std 0.07`). Sollte bimodal sein (Augen offen ≈ 0.85, Augen zu ≈ 0.15). Möglicherweise konservativer CLIP-Prompt oder schlecht für Personen-Bursts trainiert. **Mitigation:** `face_composition` (0.10) und `face_sharpness` (0.40) dominieren bereits; eyes_open trägt nur 0.20.

2. **Burst-Diskriminierung bricht zusammen**: Innerhalb einer Burst sind 5 von 9 Signalen quasi konstant (gleiche Szene, Kamera, Belichtung). Echte Diskriminatoren sind `face_sharpness`, `face_coverage`, `eyes_open`, `face_composition`. Bei Nicht-Personen-Bursts gibt es kein starkes Signal — das erklärt die hohe `low`-Quote.

3. **Auto-Hide ist nicht "kept ⊆ pick"-perfekt**: Im Sample hatte high-Confidence nur 38 % kept⊆pick. Tendenz: User behält mehr Fotos pro Burst als die KI. **Mitigation:** Toggle "KI-ausgeblendete anzeigen" + One-Click-Pick + Per-User-Kalibrierung. Sollte sich mit Stufe D (PR #413) entspannen.

4. **Multi-User-Workload**: Bei mehreren Usern auf demselben Server bekommt jeder User seine eigenen Gewichte. Backfill / Recompute / Bulk-Apply sind explizit server-weit, andere Operationen pro User.

### Offene Optionen (Priorität, sortiert nach erwartetem Hebel)

#### Niedrig hängend
- **D (eyes_open ersetzen)**: Mediapipe Face Landmarks → Eye Aspect Ratio. Echtes bimodales Signal. Würde Burst-Tiebreaking bei Portraits deutlich verbessern. Aufwand: 1 PR im `embedding_service` + Re-Scan. Risiko niedrig — nur ein Signal wird besser.
- **F/G/H (Schwellen-Tuning)**: nach dem nächsten Kalibrierungs-Export bewerten, ob die aktuellen Defaults zu konservativ/aggressiv sind. Eine Konstante zu drehen ist trivial.
- **I (Calibration-Report-Endpoint)**: `GET /photos/groups/ai-pick-stats` mit aktuellen Trefferquoten pro Confidence-Stufe + Verteilungen. Card in DataManagement, täglich aktualisiert. Aufwand: ~1 PR.

#### Mittel
- **B aus Phase 4 (Keyboard-Walk)**: Power-User-Modus für das Review-Queue-View. Eine Karte pro Bildschirm, Leertaste = Accept, ↑ = Skip, Enter = Manual. 1 Sekunde pro Gruppe machbar.
- **B aus Phase 3 (MUSIQ / HyperIQA)**: zusätzliches IQA-Signal in der Quality-Pipeline. ~5 h Initial-Compute auf CPU. Würde Nicht-Personen-Bursts stärken, wo aktuell wenig Diskriminierungs-Information da ist.

#### Hoch
- **C aus Phase 3 (VLM-Tiebreaker)**: LLaVA-3B GGUF im `llm-service` nur für Gruppen mit `runner_up_delta < 0.05`. Etwa 5–10 % der Gruppen. CPU-tauglich weil selektiv. Aufwand: neuer Modell-Pull, Vision-Endpoint, Prompt-Engineering — substantial.
- **Stufe-D Auto-Re-Calibrate**: Trigger nach N neuen User-Reviews automatisch ein erneutes Fit. Spart manuelle Klicks. Voraussetzung: Effekt-Beobachtung über mehrere Wochen.

## Session-Historie (Stand: Track-I-Roll-Out)

15 Pull Requests in dieser Iteration:

| PR | Inhalt |
|----|--------|
| #402 | Initialer Track-I-Stack: Migration 0075, Scoring, Multi-Pick, Confidence, find-groups-Integration, Endpoints, Marker-UX im Grid, Filter-Toggle, Compare-Dialog-Button, Admin-Buttons |
| #403 | Orientation-Diversität + width/height (Migration 0076) |
| #404 | Backfill + Recompute server-weit (statt user-scoped) |
| #405 | Kalibrierungs-Export scort reviewte Gruppen inline |
| #406 | Fix DB-Key-Mapping (sharpness/contrast/exposure/eyes_open) + Reset stale state (Migration 0077) |
| #407 | `face_composition`-Signal + Initialdoku `docs/ai-auto-pick.md` (Migration 0078) |
| #408 | Click-Semantik in PhotoGrid (versehentlich falsche Komponente fixiert) |
| #409 | Hidden-Siblings-Marker in Grid + Fullscreen, URL-Sync-Fix, Filter-Persistenz |
| #410 | Track-I-Marker in **VirtualGallery** (die echte Galerie) + PhotoGrid.vue gelöscht (toter Code) |
| #411 | Drei Bugs in der Filter-Toggle-Pipeline (URL-Round-Trip-Race, Partial-Page-Init-Marker, Scroll-Anker) |
| #412 | Soft-Reload nach Review (versteckte Fotos verschwinden aus Grid) |
| #413 | **Stufe D**: per-User-Pairwise-Regression (Migration 0079) |
| #414 | **Stufe A + D + C**: Rapid-Review-View, Confidence-Bar, Bulk-Disclaimer, One-Click-Pick (offen während Doku-Update) |

Plus zwei Bonus-Erkenntnisse aus der Session:
- **PhotoGrid.vue war toter Code.** Wurde in PRs #408 und #409 versehentlich angefasst statt VirtualGallery. Mit #410 entfernt.
- **eyes_open ist schwach in der User-Bestandsdaten**, weil der User Blinzel-Frames bereits manuell aussortiert hatte. Bei neuen Uploads sollte das Signal wieder aussagekräftig sein.

## Relevante Source-Dateien

Backend:
- `photo/group-auto-pick.ts` — Pure Scoring-Logik (kein DB-Zugriff)
- `photo/group-auto-pick.service.ts` — DB-Aggregation + Persistenz + Review-Queue + Accept-Flow
- `photo/group-auto-pick.calibration.ts` — Pairwise-Logistic-Regression
- `photo/group-auto-pick.test.ts` — Unit-Tests der Scoring-Logik
- `photo/group-auto-pick.service.test.ts` — Integration-Tests mit DB
- `photo/group-auto-pick.calibration.test.ts` — Regression-Math + Feature-Vektor-Helpers
- `photo/photo.service.ts` — `findPhotoGroupsLogic`, `backfillPhotoDimensionsLogic`, Wiring an `findGroups`
- `photo/photo.ts` — REST-Endpoints
- `photo/photo.filters.ts` — `aiHiddenMode`-Filterklausel
- `photo/gallery-grid.service.ts` — Surface der Pick-Info pro Grid-Zelle
- `db/schema.ts` — `photoGroups.ai_picked_*` + `aiPickUserWeights`

Frontend:
- `frontend/src/api/photos.ts` — API-Client-Wrapper für alle AI-Pick-Endpoints
- `frontend/src/api/gallery.ts` — `GalleryGridGroup` mit `ai_picked` / `ai_confidence`
- `frontend/src/views/GalleryView.vue` — Hauptgalerie, Wiring von Compare-Dialog + Soft-Reload
- `frontend/src/views/ReviewQueueView.vue` — **Rapid-Review-UI** (Stufe A + C + D)
- `frontend/src/views/DataManagementView.vue` — Admin-Buttons
- `frontend/src/components/VirtualGallery.vue` — Marker-Rendering im Haupt-Grid
- `frontend/src/components/FullscreenOverlay.vue` — Fullscreen-Marker
- `frontend/src/components/FilterMenu.vue` — "KI-ausgeblendete anzeigen"-Toggle
- `frontend/src/components/PhotoCompareView.vue` — "KI-Vorschlag übernehmen"-Button
- `frontend/src/composables/useFilter.ts` — URL-Sync inkl. `showAiHidden`
- `frontend/src/composables/useGallerySource.ts` — Sparse-Page-Cache mit korrigierter Partial-Page-Markierung
- `frontend/src/config/modules.ts` — Route + Menüeintrag für `/fotos/review-queue`

iOS (SwiftUI, Issue #761):
- `ios/Sources/FKPhotos/Features/Review/ReviewQueueModels.swift` — Wire-Typen der
  Review-Queue, Entscheidungs-Kinds, Wisch→Entscheidung-Mapping und der
  Cursor/Undo-Puffer (`ReviewQueueState`)
- `ios/Sources/FKPhotos/Features/Review/ReviewQueueViewModel.swift` — Laden,
  Pagination, serialisierte Commit-Kette
- `ios/Sources/FKPhotos/Features/Review/ReviewQueueView.swift` — Karten-UI mit
  Wischgesten und gleichwertigen Buttons
- `ios/Sources/FKPhotos/Features/Review/ReviewPhotoPreview.swift` — zoombare
  Großansicht der Gruppenmitglieder mit dem beschrifteten „Nur dieses Foto
  behalten"-Button
- `ios/Sources/FKPhotos/Features/Feed/FeedView.swift` — Einstiegspunkt in der
  Feed-Toolbar
- `ios/Tests/FKPhotosTests/ReviewQueueTests.swift` — Tests für Mapping + Undo

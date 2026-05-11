# AI Auto-Pick: Best-of-Group für ähnliche Foto-Gruppen

## Summary

Track I des Auto-Selection-Plans (Issue #358 / #346). Bei 50 k+ Fotos
entstehen über die DINOv2-Ähnlichkeitssuche typischerweise 5 k+
Similar-Groups. Manuelles Review ist nicht skalierbar. Die KI bewertet
jede Gruppe anhand bereits vorhandener Per-Foto-Signale und schlägt
einen "Best-of-Group"-Pick vor (oder mehrere bei knapper Entscheidung).
Der User kann den Vorschlag übernehmen, ignorieren oder per Toggle
übersteuern. **User-Entscheidungen haben immer Vorrang** — die KI fasst
reviewte Gruppen nicht mehr an.

## Pipeline

```
                     ┌──────────────────────────────────────────┐
                     │  embedding_service                       │
                     │  (Python, separate Container)            │
                     │   • DINOv2 Embeddings → pgvector         │
                     │   • Quality-Scorer schreibt nach         │
                     │     photos.ai_quality_details (JSONB)    │
                     │     - sharpness                          │
                     │     - contrast                           │
                     │     - exposure                           │
                     │     - clip_aesthetics / composition /    │
                     │       technical                          │
                     │     - face_sharpness                     │
                     │     - eyes_open                          │
                     │     - face_composition                   │
                     │   • InsightFace → faces.bbox (JSON)      │
                     └──────────────────┬───────────────────────┘
                                        │
                                        ▼
        ┌────────────────────────────────────────────────────┐
        │  photo.service.ts                                  │
        │   • findPhotoGroupsLogic – clustert über pgvector  │
        │     → photo_groups, photo_group_members            │
        │   • Am Ende: recomputeAiPicksForUser()             │
        │     scort alle unreviewten Gruppen                 │
        └──────────────────┬─────────────────────────────────┘
                           │
                           ▼
        ┌────────────────────────────────────────────────────┐
        │  group-auto-pick.service.ts                        │
        │   • loadSignalsForPhotos – ein Query pro Batch     │
        │   • Aggregiert face_coverage aus faces.bbox        │
        │   • Klassifiziert orientation aus photos.width/.h  │
        │   • Persistiert in photo_groups.ai_pick_details    │
        │     (per-Foto Score + Sub-Signale)                 │
        └──────────────────┬─────────────────────────────────┘
                           │
                           ▼
        ┌────────────────────────────────────────────────────┐
        │  group-auto-pick.ts (pure logic, kein DB-Zugriff)  │
        │   • scorePhoto – Linearkombination der Signale     │
        │   • computeGroupPick – Multi-Pick + Confidence     │
        │     + Orientation-Diversität                       │
        └────────────────────────────────────────────────────┘
```

## Scoring-Formel

Pro Foto wird ein Score in [0, 1] berechnet. Branch je nachdem ob
mindestens ein Gesicht detektiert wurde:

### Face-Branch (`faces.count > 0`)

| Signal              | Gewicht | Quelle |
|---------------------|---------|--------|
| `face_sharpness`    | 0.40    | `ai_quality_details.face_sharpness` |
| `eyes_open`         | 0.20    | `ai_quality_details.eyes_open` |
| `face_coverage`     | 0.15    | Σ(`faces.bbox.width · height`), saturiert bei 30 % |
| `face_composition`  | 0.10    | `ai_quality_details.face_composition` |
| `sharpness` (global)| 0.05    | `ai_quality_details.sharpness` |
| `clip_aesthetics`   | 0.05    | `ai_quality_details.clip_aesthetics` |
| `exposure+contrast` | 0.05    | 0.5 · (`exposure` + `contrast`) |

### Non-Face-Branch

| Signal              | Gewicht | Quelle |
|---------------------|---------|--------|
| `sharpness`         | 0.40    | `ai_quality_details.sharpness` |
| `clip_aesthetics`   | 0.25    | `ai_quality_details.clip_aesthetics` |
| `clip_composition`  | 0.15    | `ai_quality_details.clip_composition` |
| `clip_technical`    | 0.10    | `ai_quality_details.clip_technical` |
| `exposure+contrast` | 0.10    | 0.5 · (`exposure` + `contrast`) |

Fehlende Einzelsignale werden auf neutral 0.5 gemappt (`clamp01`), damit
ein Foto mit unvollständiger Qualitäts-Bewertung weder bestraft noch
belohnt wird.

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

**Orientation-Diversität:** Enthält die Gruppe gleichzeitig Portrait-
und Landscape-Fotos derselben Szene, wird zusätzlich pro vorhandener
Orientierung das jeweils beste Foto gepickt — sofern es mindestens
`ORIENTATION_FLOOR · top.score` (0.75) erreicht. Square-Fotos werden
ignoriert, damit ein einzelner annähernd quadratischer Outlier in
einer Portrait-Burst keinen Slot kapert.

## UX-Verhalten

- **`high` Confidence:** Nicht-Picks werden im Grid automatisch
  versteckt (über Server-Filter `aiHiddenMode=exclude`). User sieht im
  Grid nur die Picks, mit einem `+N`-Marker am Cover-Foto.
- **`medium`:** Marker mit Orange-Tint, **kein** Auto-Hide.
- **`low`:** Marker neutral, **kein** Auto-Hide.

**Click-Semantik im Grid** ist überall einheitlich, unabhängig von der
Confidence-Stufe:

- **Klick auf das Foto selbst** → Fullscreen-Ansicht (wie bei jedem
  Foto). Die KI-Auswahl ist die Standard-Ansicht — der User soll sie
  ohne Reibung anschauen können.
- **Klick auf den `+N`-Marker** → Review-Dialog (`PhotoCompareView`)
  mit allen Gruppen-Mitgliedern und dem "KI-Vorschlag übernehmen"-
  Button.
- **Ctrl/Cmd/Shift-Klick** auf irgendeinen Teil eines Gruppen-Fotos →
  Multi-Select der **ganzen** Gruppe.

Im Review-Dialog (`PhotoCompareView.vue`) gibt es einen
"KI-Vorschlag übernehmen"-Button. Klick →
`POST /photos/groups/:id/accept-ai-pick` → die Nicht-Picks werden über
das bestehende `photo_curation`-Mechanismus auf `hidden` gesetzt (Favoriten
bleiben **immer** geschützt), die Gruppe wird als reviewt markiert.

**Bulk-Apply:** In der `DataManagementView` gibt es
"Alle hochkonfidenten KI-Picks bestätigen"
(`POST /photos/groups/bulk-accept-ai-picks`). Wendet das Accept für
alle `high`-Confidence Gruppen ohne `reviewed_at` an. Macht den ersten
Roll-out auf tausende Gruppen praktikabel.

**Filter-Toggle:** In `FilterMenu.vue` neben "Ausgeblendete anzeigen"
liegt "KI-ausgeblendete anzeigen". Aktiviert setzt der Client
`showAiHidden=true` → Server-Filter wird zu `aiHiddenMode=include` →
alle KI-versteckten Fotos werden wieder sichtbar (Marker bleibt).

## Datenmodell

### `photo_groups` (erweitert in Migration 0075)

| Spalte                | Bedeutung |
|-----------------------|-----------|
| `ai_picked_photo_ids` | `INTEGER[]`. Mehrere Picks möglich (Multi-Pick + Orientation-Diversity). NULL = nicht gescort. |
| `ai_picked_at`        | `TIMESTAMPTZ`. Wall-Clock des letzten Scoring-Passes. |
| `ai_picked_confidence`| `TEXT`: `high` / `medium` / `low`. Treibt den Gallery-Filter. |
| `ai_pick_details`     | `JSONB`. Per-Foto Score + Sub-Signale (für Stufe-D-Kalibrierung). |

`reviewed_at` (bestehende Spalte) hat Vorrang: KI-Picks werden auf
reviewten Gruppen weder neu berechnet noch im Gallery-Filter angewandt.

### `photos` (erweitert in Migration 0076)

| Spalte   | Bedeutung |
|----------|-----------|
| `width`  | post-EXIF-Rotation. Befüllt im Face-Scan-Pfad + per Backfill-Endpoint. |
| `height` | dito. |

Wird von `classifyOrientation` zur Orientation-Diversity-Regel genutzt.
NULL → Orientation undefined → Regel no-ops (sichere Degradation).

## API-Endpoints (`photo/photo.ts`)

| Method | Path                                         | Funktion |
|--------|----------------------------------------------|----------|
| `POST` | `/photos/find-groups`                        | Re-clustering. Recompute der KI-Picks läuft am Ende implizit. |
| `POST` | `/photos/groups/recompute-ai-picks`          | Server-weit, alle unreviewten Gruppen neu scoren. Admin-Button. |
| `POST` | `/photos/groups/:id/accept-ai-pick`          | KI-Pick als User-Entscheidung übernehmen (Hide via curation). |
| `POST` | `/photos/groups/bulk-accept-ai-picks`        | Bulk-Accept aller hochkonfidenten Gruppen des Users. |
| `GET`  | `/photos/groups/ai-pick-calibration`         | Kalibrierungs-Export. Scort reviewte Gruppen inline bei Bedarf. |
| `POST` | `/photos/backfill-dimensions`                | Server-weiter Backfill von width/height für Bestandsfotos. |

Alle Endpoints benötigen `data.manage` (außer accept-ai-pick →
`photos.delete`).

## Kalibrierungs-Workflow

1. User reviewt einige Gruppen manuell (mind. 50, idealerweise 100+).
   "Reviewt" heißt: User hat die KI-Picks bestätigt, oder per Compare-
   Dialog Fotos auf `hidden` gesetzt.
2. "Kalibrierungs-Export herunterladen" im DataManagement.
   Browser bekommt eine JSON-Datei mit pro-Gruppe:
   - `group_ai_picked_photo_ids`
   - `group_confidence`
   - Pro Foto: `user_kept`, `ai_picked`, alle Sub-Signale
3. Offline-Analyse mit Python (Beispiel-Snippet siehe Investigation-
   Kommentar auf #346) misst die Trefferquote der KI gegen die User-
   Entscheidungen — getrennt nach Confidence-Stufe.
4. Anhand der Ergebnisse Gewichte neu kalibrieren (Stufe D, noch nicht
   automatisiert).

## Konfigurations-Knobs

Alles in `photo/group-auto-pick.ts` als Module-Konstanten:

| Konstante                  | Default | Bedeutung |
|----------------------------|---------|-----------|
| `MULTI_PICK_THRESHOLD`     | 0.92    | Multi-Pick-Cutoff relativ zum Top-Score. |
| `HIGH_CONFIDENCE_DELTA`    | 0.10    | Score-Abstand für `high` → Auto-Hide. |
| `MEDIUM_CONFIDENCE_DELTA`  | 0.04    | Untere Grenze für `medium`. |
| `ORIENTATION_FLOOR`        | 0.75    | Floor für Promotion via Orientation-Diversity. |
| `SATURATION` (in `normaliseFaceCoverage`) | 0.30 | Face-Coverage saturiert ab 30 % Bildanteil. |

Gewichte in der `scorePhoto`-Funktion direkt; Änderungen brauchen
neuen Recompute (`POST /photos/groups/recompute-ai-picks`) plus
neuen Kalibrierungs-Export.

## Bekannte Schwächen + Verbesserungs-Optionen

### Beobachtungen aus dem ersten produktiven Kalibrierungs-Export (~119 reviewte Gruppen)

| Confidence | N  | Top-1 in user-kept | kept ⊆ pick |
|------------|----|---------------------|-------------|
| `high`     | 21 | 76 %                | 38 %        |
| `medium`   | 9  | 100 %               | 78 %        |
| `low`      | 88 | 73 %                | 100 %       |

74 % aller Gruppen landen in `low`. Score-Gap zwischen Top und
Runner-up bei `low`: mean **0.009**.

### Schwäche 1 — Burst-Diskriminierung bricht zusammen

Innerhalb einer Burst sind 5 von 9 Signalen quasi konstant (`sharpness`,
`contrast`, `clip_*`): gleiche Szene, gleiche Kamera, gleiche
Belichtung. Übrig bleiben als echte Burst-Diskriminatoren:
`face_sharpness`, `face_coverage`, `eyes_open`, `face_composition`. Bei
Nicht-Personen-Bursts gibt es **kein** starkes Diskriminations-Signal.

**Optionen:**

- **A. Pairwise-Regression mit logistic auf der vorhandenen
  Kalibrierungs-Stichprobe.** Lernt aus User-Override-Events welche
  Signale wo entscheidend sind. Datenmodell ist vorbereitet
  (`ai_pick_details.scores` enthält alle Sub-Signale + Entscheidung
  über `photo_curation`).
- **B. Modernes Deep-IQA als zusätzliches Signal.** MUSIQ / HyperIQA /
  MANIQA. Genauer als Laplacian-Sharpness, aber CPU-schwer (~300 ms /
  Bild → ~5 h initial für 50 k Fotos). Würde insbesondere bei
  Nicht-Personen-Bursts helfen.
- **C. VLM (Vision-Language-Model) als Confidence-Tiebreaker.** Nur für
  unsichere Gruppen (`runner_up_delta < 0.05`), das sind ~5–10 % aller
  Gruppen. LLaVA-3B-GGUF im bestehenden `llm-service`. Praktikabel auf
  CPU, weil nur ein Bruchteil der Gruppen.

### Schwäche 2 — `eyes_open` schwächer als erwartet

Im Sample: range nur 0.35–0.67 (`std=0.07`). Erwartet wäre eine
bimodale Verteilung (Augen offen ≈ 0.85, Augen zu ≈ 0.15). Mögliche
Erklärung des Users: die Bestandsdaten sind bereits manuell von
Blink-Frames bereinigt, also hat das Signal hier wenig zu tun.

**Optionen:**

- **D. Embedding-Service Quality-Pipeline prüfen.** Ggf. den
  CLIP-Prompt-Pair für eyes-open neu kalibrieren oder durch einen
  dedizierten Eye-Aspect-Ratio-Detektor (z. B. Mediapipe-Landmarks)
  ersetzen. Würde Burst-Tiebreaking bei Portraits stark verbessern.
- **E. Re-Validierung mit neuen Daten.** Bei künftigen Uploads bleiben
  Blink-Frames im Sample → das Signal kann erneut bewertet werden.

### Schwäche 3 — Auto-Hide ist auf den vorhandenen Daten leicht
**zu aggressiv**

`kept ⊆ pick` bei `high` Confidence: nur 38 %. In 62 % der `high`-
Gruppen würde Auto-Hide ein Foto verstecken, das der User bewusst
behalten hat. **Mitigation existiert:** Filter-Toggle
"KI-ausgeblendete anzeigen" macht alle versteckten Fotos sichtbar.

**Optionen:**

- **F. Confidence-Schwelle anheben.** `HIGH_CONFIDENCE_DELTA` von 0.10
  auf 0.15. Weniger `high`-Gruppen, dafür höhere Genauigkeit.
- **G. Hide-Schwelle absolut statt relativ.** Zusätzlich zum Pick-Set:
  verstecke nur Fotos mit `score < 0.4` (absolut), egal welche
  Confidence-Stufe. So bleiben "schlecht aber besser als 0.4" sichtbar.
- **H. Multi-Pick-Schwelle senken (z. B. 0.92 → 0.85).** Mehr Fotos im
  Pick-Set → weniger versteckte Fotos. Trade-off: weniger Reibungsabbau
  für klar dominante Gruppen.

### Schwäche 4 — Stufe-D-Kalibrierung noch manuell

Die Gewichts-Kalibrierung läuft heute offline via Python-Snippet (siehe
Investigation-Kommentar auf #346). Trefferquoten muss man von Hand
auswerten.

**Optionen:**

- **I. Eingebauter Calibration-Report.** Endpoint
  `GET /photos/groups/ai-pick-stats` der pro Confidence-Stufe die
  aktuellen Trefferquoten zurückgibt. UI-Card in DataManagementView,
  täglich aktualisiert.
- **J. Automatische Gewichts-Regression.** Pairwise-Logistic auf den
  reviewten Gruppen, Ergebnis als Vorschlag, manuell deployen. Würde
  pro User funktionieren (Per-User-Präferenzen sind real).

### Schwäche 5 — Reviewte Gruppen "veralten"

Nach einem Re-Scan oder Re-Embedding können Gruppen ihre Mitglieder
ändern. Aktuell: unreviewte Gruppen werden bei `find-groups` komplett
neu gebaut + rescort. **Reviewte** Gruppen bleiben unangetastet, was
gewollt ist (User-Entscheidung bewahren) — aber wenn der Re-Scan
zusätzliche ähnliche Fotos in eine bestehende reviewte Gruppe einsortieren
würde, sind die neuen Fotos nicht im Pick-Set und werden auch nicht
auto-hidden.

**Optionen:**

- **K. "Re-Score reviewter Gruppen" nach explizitem User-Trigger.**
  Neuer Admin-Button, der `reviewed_at = NULL` setzt für Gruppen mit
  veränderten Mitgliedern. Erfordert Tracking von Membership-Hashes.
- **L. Implizite Re-Review-Markierung bei Membership-Change.** Wenn
  ein Re-Scan einer Gruppe neue Mitglieder hinzufügt, automatisch in
  einen "needs-re-review"-State setzen.

## Migration-Historie

| # | Datum | Inhalt |
|---|-------|--------|
| 0075 | 2026-05 | Initiale `ai_picked_*`-Spalten + Partial-Index. |
| 0076 | 2026-05 | `photos.width`/`height` für Orientation-Diversität. |
| 0077 | 2026-05 | Reset stale picks (Bugfix: Key-Mapping `_score` vs. ohne). |
| 0078 | 2026-05 | Reset stale picks (Gewichts-Retuning + `face_composition`). |

## Relevante Source-Dateien

- `photo/group-auto-pick.ts` — Pure Scoring-Logik (kein DB-Zugriff)
- `photo/group-auto-pick.service.ts` — DB-Aggregation + Persistenz
- `photo/group-auto-pick.test.ts` — Unit-Tests der reinen Logik
- `photo/group-auto-pick.service.test.ts` — Integration-Tests mit DB
- `photo/photo.service.ts` — `findPhotoGroupsLogic`,
  `backfillPhotoDimensionsLogic`, Wiring an `findGroups`
- `photo/photo.ts` — REST-Endpoints
- `photo/photo.filters.ts` — `aiHiddenMode`-Filterklausel
- `photo/gallery-grid.service.ts` — Surface der Pick-Info pro Grid-Zelle
- `frontend/src/api/photos.ts` — API-Client-Wrapper
- `frontend/src/components/PhotoGrid.vue` — Marker-Rendering
- `frontend/src/components/PhotoCompareView.vue` — "Übernehmen"-Button
- `frontend/src/components/FilterMenu.vue` — "KI-ausgeblendete anzeigen"
- `frontend/src/views/DataManagementView.vue` — Admin-Buttons

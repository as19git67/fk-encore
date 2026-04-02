# Auto-Crop: Intelligente Thumbnail-Positionierung

## Zusammenfassung

Hochkant-Bilder (Portrait) werden im Grid als quadratische Thumbnails angezeigt.
Standardmässig schneidet der Browser dabei oben und unten gleichmässig ab (zentriert).
Mit Auto-Crop wird der sichtbare Ausschnitt so verschoben, dass erkannte Gesichter
oder Sehenswürdigkeiten im Fokus stehen.

## Funktionsweise

### Kein serverseitiges Zuschneiden

Das Originalbild und das generierte Thumbnail werden **nicht** verändert.
Das Thumbnail bleibt ein normales, proportional skaliertes JPEG (z.B. 400px breit).

Der Trick passiert rein im **CSS**: Das Thumbnail wird im Grid in einem 1:1-Quadrat
mit `object-fit: cover` dargestellt. Dabei bestimmt `object-position`, welcher
Ausschnitt des Bildes sichtbar ist.

```
Ohne Auto-Crop (Standard):         Mit Auto-Crop (Gesicht oben):
object-position: 50% 50%           object-position: 50% 30%

┌─────────┐                        ┌─────────┐
│ xxxxxxx │ ← abgeschnitten        │  ( ^ ^) │ ← Gesicht sichtbar
│         │                        │   \_/   │
│  ( ^ ^) │ ← Gesicht              │ xxxxxxx │
│   \_/   │                        │ xxxxxxx │
│ xxxxxxx │ ← abgeschnitten        │ xxxxxxx │ ← abgeschnitten
└─────────┘                        └─────────┘
```

### Fokuspunkt-Berechnung

Der Fokuspunkt wird als normalisierte Koordinaten `{ x: 0..1, y: 0..1 }` gespeichert
und nach folgender Priorität berechnet:

1. **Gesichter** (Priorität): Gewichteter Schwerpunkt aller erkannten Gesichter.
   Grössere Gesichter haben mehr Gewicht, damit das Hauptgesicht den Ausschnitt bestimmt.
2. **Landmarks** (Fallback): Wenn keine Gesichter vorhanden sind, wird das Landmark
   mit der höchsten Confidence verwendet (z.B. ein Gebäude, eine Brücke).
3. **Kein Crop**: Wenn weder Gesichter noch Landmarks erkannt wurden, bleibt
   `auto_crop` leer und der Browser verwendet die Standard-Zentrierung (50%/50%).

### Beispiel

Ein Hochkant-Foto mit einem Gesicht im oberen Drittel:

- Gesichts-BBox: `{ x: 0.3, y: 0.15, width: 0.4, height: 0.2 }`
- Berechneter Fokus: `{ x: 0.5, y: 0.25 }` (Mitte der BBox)
- CSS: `object-position: 50% 25%`
- Ergebnis: Der sichtbare Ausschnitt verschiebt sich nach oben zum Gesicht.

## Technische Details

### Datenbank

Spalte `auto_crop` (JSONB, nullable) auf der `photos`-Tabelle:

```json
{ "x": 0.5, "y": 0.25 }
```

Migration: `db/migrations/postgres/0010_auto_crop.sql`

### Backend

- **`computeAndStoreAutoCrop(userId, photoId)`** in `photo/photo.service.ts`
  - Liest alle nicht-ignorierten Gesichter und Landmarks aus der DB
  - Berechnet den gewichteten Fokuspunkt
  - Speichert das Ergebnis in `photos.auto_crop`
- Wird automatisch am Ende von `indexPhotoFaces()` und `indexPhotoLandmarks()` aufgerufen
- **Bulk-Endpoint**: `POST /photos/recompute-auto-crops` berechnet den Fokuspunkt
  für alle bestehenden Fotos anhand vorhandener Erkennungsdaten neu

### Frontend

- `PhotoGrid.vue` liest `photo.auto_crop` und setzt es als `imageStyle`:
  ```ts
  { objectPosition: `${auto_crop.x * 100}% ${auto_crop.y * 100}%` }
  ```
- `HeicImage.vue` wendet den Style auf das `<img>`-Element an (via `:style="imageStyle"`)
- Funktioniert in allen Grid-Ansichten: Fotos, Alben, Suchergebnisse

### Datenverwaltung

In der Datenverwaltung (DataManagementView) gibt es den Button
**"Auto-Crop neu berechnen"**, der den Fokuspunkt für alle Fotos
anhand der bereits vorhandenen Gesichts-/Landmark-Daten neu berechnet.
Dies ist einmalig nötig für Fotos, die vor Einführung des Features hochgeladen wurden.

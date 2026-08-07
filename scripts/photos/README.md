# Foto-Diagnose-Skripte

Read-only Auswertungen gegen die produktive Datenbank. Die Skripte führen
ausschließlich `SELECT`-Abfragen aus und schreiben ihren Report nach
`scripts/photos/out/` (gitignored).

## `diagnose-autopick-faces.mjs`

Prüft, ob die `min()`-Aggregation von `face_sharpness` / `eyes_open` im
embedding_service die Auto-Pick-Vorschläge auf Fotos mit vielen Gesichtern
verschlechtert.

**Hintergrund:** `face_sharpness` ist das Minimum über *alle* erkannten
Gesichter (Filter: nur ≥10 px Kantenlänge in der Quelle) und trägt zusammen
mit `eyes_open` 0.60 der Gewichte im Face-Zweig von `scorePhoto()`. Auf einem
Menschenmengen-Foto misst das Minimum damit potenziell den unschärfsten
Statisten im Hintergrund statt des Motivs — und kann zwischen zwei Frames
desselben Bursts springen, weil ein anderes Hintergrundgesicht das Minimum
stellt.

**Was ausgewertet wird** (alles aus bereits gespeicherten Daten, kein Re-Scan
nötig — der Pick liegt in `photo_groups.ai_pick_details`, die
Nutzer-Entscheidung in `photo_curation`):

1. Gespeicherte Kalibrierungs-Metadaten (Face- vs. Non-Face-Genauigkeit).
2. **Trefferquote nach Gesichtszahl** — die Kernmessung. Fällt sie zu den
   hohen Buckets hin ab, ist die Vermutung bestätigt.
3. Prominenz-Spreizung: wie oft ist das kleinste Gesicht viel kleiner als das
   größte (= wie oft misst `min()` etwas anderes als das Motiv).
4. Fotos, die nur durch winzige Detektionen in den Face-Zweig geraten.
5. Als "ignoriert" markierte Gesichter, die im Scoring trotzdem zählen.
6. Streuung von `face_sharpness` vs. `blur` innerhalb einer Gruppe
   (Signatur eines instabilen Minimums).

**Aufruf:**

```bash
node scripts/photos/diagnose-autopick-faces.mjs
USER_ID=3 node scripts/photos/diagnose-autopick-faces.mjs   # nur ein Nutzer
```

Verbindung wie `db/database.ts`: `POSTGRES_CONNECTION_STRING` oder
`POSTGRES_HOST` / `PORT` / `USER` / `PASSWORD` / `DATABASE` (Standard-DB:
`fk_encore`).

**Grenzen der Aussagekraft:** gemessen wird nur, wo bereits reviewt wurde und
ein Pick gespeichert ist. Reviewte Gruppen sind keine Zufallsstichprobe der
Bibliothek. Gruppen, in denen der Nutzer nichts ausgeblendet hat, werden
übersprungen — dort träfe jeder Pick trivial.

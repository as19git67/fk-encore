# Rückblick-Musik

Rückblicke spielen automatisch Hintergrundmusik, sobald Audiodateien im
Musik-Ordner liegen. Ohne Dateien laufen Rückblicke einfach stumm — es ist
keine weitere Konfiguration nötig.

## Ordner-Struktur

Der Ordner wird über die Umgebungsvariable `RECAPS_MUSIC_DIR` konfiguriert
(Default: `/mnt/data/recap-music`). Darin gibt es vier Stimmungs-Unterordner:

```
recap-music/
├── upbeat/      # treibend, fröhlich   → Reisen, „Kürzlich“-Highlights
├── warm/        # warm, herzlich       → Personen-Rückblicke
├── nostalgic/   # nostalgisch, ruhig   → „Heute vor X Jahren“
└── calm/        # ruhig, atmosphärisch → Orte, Themen
```

Einfach Dateien hineinlegen — mehr ist nicht zu tun:

- Unterstützte Formate: `.mp3`, `.m4a`, `.aac`, `.ogg`, `.wav`
  (MP3 oder M4A empfohlen, das spielen Web und iOS ohne Sonderfälle).
- Der Track-Titel wird aus dem Dateinamen abgeleitet:
  `01_sunny-road.mp3` → „Sunny Road“ (führende Nummern werden entfernt).
- Versteckte Dateien (`.foo.mp3`) und Nicht-Audio-Dateien werden ignoriert.
- Empfohlen: instrumentale Stücke mit 2–3 Minuten Länge; der Player loopt.
  Auf einheitliche Lautstärke achten (ggf. vorher normalisieren, z. B. mit
  `ffmpeg -i in.mp3 -filter:a loudnorm out.mp3`).

## Wie die Auswahl funktioniert

- Jede Rückblick-Art ist fest einer Stimmung zugeordnet (siehe oben).
- Pro Rückblick wird deterministisch ein Track aus dem passenden
  Stimmungs-Ordner gewählt — derselbe Rückblick bekommt bei jedem Abspielen
  denselben Track.
- Ist ein Stimmungs-Ordner leer, wird auf den Gesamtbestand ausgewichen.
- Der Player (Web und iOS) blendet die Musik sanft ein und aus, koppelt sie
  an Pause/Weiter und hat einen Stummschalt-Knopf.

## Woher Musik nehmen? (Lizenz!)

Nur Musik verwenden, deren Lizenz das Einbetten in eine eigene Anwendung
erlaubt. Bewährte Quellen:

- **Pixabay Music** (https://pixabay.com/music/) — kostenlos, kommerzielle
  Nutzung erlaubt, keine Namensnennung nötig. Beste erste Anlaufstelle.
- **Free Music Archive** (https://freemusicarchive.org/) — Lizenz je Track
  prüfen; CC-BY erfordert Namensnennung.
- **Incompetech / Kevin MacLeod** (https://incompetech.com/) — CC-BY.

**Nicht** geeignet: Abo-Dienste (Epidemic Sound, Artlist — Lizenz erlischt
mit dem Abo), YouTube Audio Library (nur für YouTube-Videos lizenziert),
gekaufte/gestreamte Musik aus iTunes/Spotify o. ä.

Tipp: Pro Track eine Zeile mit Quelle und Lizenz in einer `LICENSES.txt`
im Musik-Ordner festhalten — die Datei wird ignoriert und stört nicht.

## API

- `GET /recaps-music` — listet alle Tracks (`id`, `mood`, `title`, `url`).
- `GET /recaps-music/file/<mood>/<datei>` — streamt einen Track
  (mit HTTP-Range-Support für Safari/AVPlayer).
- `GET /recaps/:id` — liefert im Feld `music` den vorgeschlagenen Track
  für den Player.

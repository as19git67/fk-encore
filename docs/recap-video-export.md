# Rückblick-Video-Export

Rückblicke lassen sich als MP4 exportieren (Button „Video" in der
Detail-Ansicht der Web-App): 1080p, H.264 + AAC, Ken-Burns-Zoom pro Folie,
Crossfades und die Hintergrundmusik des Rückblicks (falls Tracks im
Musik-Ordner liegen, siehe `docs/recap-music.md`).

## Voraussetzung: ffmpeg

Der Export braucht ein `ffmpeg`-Binary auf dem Server — es ist **keine**
npm-Abhängigkeit. Im Produktions-Image ist es bereits enthalten: das
Runtime-Image (`docker/Dockerfile.runtime`) installiert `ffmpeg` zusammen
mit den übrigen System-Tools per apt. Es ist also nichts weiter zu tun.

Für die lokale Entwicklung außerhalb des Containers muss `ffmpeg` einmalig
installiert werden:

```bash
apt-get install ffmpeg      # Debian/Ubuntu
brew install ffmpeg         # macOS
```

Pfad konfigurierbar über `FFMPEG_PATH` (Default: `ffmpeg` im `PATH`).
Fehlt das Binary, antwortet `POST /recaps/:id/export` mit
`failed_precondition` und einer klaren Meldung; die restliche
Rückblick-Funktionalität ist nicht betroffen.

## Ablauf

1. `POST /recaps/:id/export` startet den Render-Job (idempotent: läuft
   bereits ein Job für diesen Rückblick, wird dessen Stand zurückgegeben;
   existiert das fertige MP4 im Cache, kommt sofort `done`).
2. Frames: jedes Foto wird mit sharp EXIF-rotiert und am
   `auto_crop`-Fokuspunkt auf 16:9 beschnitten (gleiches Smart-Cropping wie
   im Player) — das löst nebenbei HEIC, ffmpeg sieht nur JPEGs.
3. ffmpeg rendert: `zoompan` (Zoom rein/raus alternierend, deterministisch
   je Foto), `xfade`-Übergänge (3,5 s pro Folie, 0,6 s Blende), Musik
   geloopt mit Fade-in/-out, `libx264 crf 20`, `faststart`.
4. `GET /recaps/:id/export/status` liefert `{ status, progress,
   download_url }`; das Frontend pollt alle 2 s und startet den Download
   automatisch.
5. Download über `GET /recaps-export/file/<name>.mp4`
   (Content-Disposition: attachment).

## Cache & Speicherort

Fertige Videos liegen unter `RECAPS_EXPORT_DIR`
(Default `/mnt/data/recap-exports`). Der Dateiname enthält einen Hash über
Foto-Set + Titel:

- ändert sich der Rückblick (Rebuild mit anderen Fotos), entsteht beim
  nächsten Export eine neue Datei;
- unveränderte Rückblicke werden ohne erneutes Encoding ausgeliefert;
- die URL ist ohne Kenntnis des Inhalts nicht erratbar (gleiches
  Schutzniveau wie `/photos/file/*`).

Alte Exporte werden derzeit nicht automatisch gelöscht — bei Platzmangel
kann das Verzeichnis gefahrlos geleert werden.

## Grenzen

- Max. 30 Fotos pro Export (entspricht der Recap-Obergrenze), ~90 s Video.
- Encoding läuft auf der CPU des Hosts; je nach Hardware dauert ein voller
  Rückblick ein bis wenige Minuten. Der Job läuft asynchron, ein Neustart
  des Servers verwirft laufende Jobs (der Status-Endpoint findet fertige
  Dateien aber auch nach einem Neustart wieder).
- Karten-Intro und „Damals & heute"-Folie sind im Export (noch) nicht
  enthalten — nur die Fotos.

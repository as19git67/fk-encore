# Foto-Diashow (Vollbild) – Feature-Dokumentation

Die Diashow ist Teil der gemeinsamen `FullscreenOverlay`-Komponente und steht
damit überall zur Verfügung, wo das Vollbild mit konfiguriertem Intervall
geöffnet wird. Sie wird **manuell per Play/Pause-Button** gesteuert und startet
nie von selbst.

## Wo es die Diashow gibt

Eine Diashow existiert genau dann, wenn der `FullscreenOverlay` mit
`autoAdvanceMs > 0` eingebunden ist:

| Ansicht | Einbindung | Diashow |
|---|---|---|
| Album-Rasteransicht (`AlbumDetailView`) | `:autoAdvanceMs="10000"` | ✅ |
| Album-Kartenansicht (`AlbumDetailView`) | `:autoAdvanceMs="10000"` | ✅ |
| Geteiltes Album (`SharedAlbumView`) | `:autoAdvanceMs="10000"` | ✅ |
| `GalleryView`, `PersonsView` | kein `autoAdvanceMs` | – |

## Play/Pause-Steuerung

- **Kein Auto-Start:** Das interne `playing`-Flag ist standardmäßig `false`. Der
  Auto-Advance läuft nur, solange der Nutzer ihn gestartet hat.
- **Toolbar-Button:** In der Action-Bar des Overlays (außerhalb des
  `actions`-Slots, damit Slot-Overrides ihn nicht verdrängen). Sichtbar, sobald
  `autoAdvanceMs > 0`.
- **Icon = Klick-Aktion:** Das Icon zeigt immer, was der Klick auslöst – ▶
  (`pi-play`) wenn gestoppt, ⏸ (`pi-pause`) während sie läuft.
- **Intervall & Idle-Reset:** Während des Laufs wird alle `autoAdvanceMs` zum
  nächsten Foto weitergeschaltet. Jede Interaktion (Pointer/Tastatur/Wheel)
  setzt das Intervall zurück, sodass erst nach kurzer Ruhe weitergeschaltet
  wird. Geöffneter Transform-Editor oder Details-Flyout pausieren ebenfalls.
- **Automatischer Stopp am Ende:** Gibt es kein nächstes Foto mehr, stoppt die
  Diashow und das Icon springt zurück auf ▶ (kein Wrap-around).

Die reine Entscheidungslogik ist in `frontend/src/utils/slideshow.ts`
ausgelagert (`shouldArmSlideshow`, `slideshowReachedEnd`) und unit-getestet; die
Komponente besitzt nur Timer und `playing`-State.

## Durchlaufen ohne Tages-/Stopp-Grenze (Kartenansicht)

Beim Öffnen des Vollbilds aus der Karte übergibt `TripMap` **alle Trip-Fotos**
in chronologischer Timeline-Reihenfolge (Tage aufsteigend, Stopps nach Zeit,
Fotos nach Zeit – Computed `allStopPhotos`), mit Start-Index auf dem angetippten
Foto. Dadurch laufen Blättern und Diashow durchgehend über alle Tage und
Stopps. Beim Schließen wird der ausgewählte Karten-Stopp auf das zuletzt
gezeigte Foto synchronisiert (`closeMapFullscreen` → `selectStopByPhotoId`).

## Datums-Banner beim Tageswechsel

Damit ein durchlaufender Tageswechsel erkennbar ist, blendet das Overlay ein
dezentes Datums-Label ein, sobald die Navigation in einen neuen Tag wechselt:

- Opt-in über die Prop `markDayChanges`.
- Tageswechsel-Erkennung über den **lokalen** Datums-Key
  (`toLocalIsoDate`, vermeidet UTC-Verschiebung) des neuen vs. zuletzt gezeigten
  Fotos; angekündigt wird nur ein **Wechsel**, nie das Startfoto (`isDayChange`).
- Das Label (z. B. „Mittwoch, 14. Januar 2026") fährt mittig unter der Topbar
  ein, bleibt ~2,5 s und fährt wieder aus – **ohne Pause** im Ablauf. Es ist
  `pointer-events: none`, blockiert also keine Taps.
- Aktiv in der Album-Kartenansicht (immer) und im geteilten Album nur, wenn das
  Vollbild aus der Karte geöffnet wurde (`fullscreenFromMap`), nicht im Raster.

## Beschreibungs-Caption

Während die Diashow läuft, wird – **falls vorhanden** – die Foto-Beschreibung
(`photo.description`) oben zentriert über dem Bild eingeblendet:

- **Einzeilig**, mit `text-overflow: ellipsis` abgeschnitten (`white-space:
  nowrap`); der volle Text steht im `title`-Tooltip.
- **Lesbarkeit** über einen dezent transluzenten, leicht geblurrten Hintergrund
  (`rgba(0,0,0,0.6)`), unabhängig von den Bildfarben.
- Gezeigt nur, wenn die Diashow läuft, kein Details-Split offen ist und eine
  nicht-leere Beschreibung existiert (`shouldShowCaption`).
- Caption und Datums-Banner teilen sich einen zentrierten Top-Stack
  (`.fs-top-overlays`), sodass sie sich nie überlappen; beide sind
  `pointer-events: none`.

Die Beschreibung ist in den Slideshow-Fotos verfügbar: Der Grid-Pfad
hydratisiert das aktuelle Foto per `getPhotoDetailsBatch`, und die
Album-/Karten-Fotos (`getAlbumLogic`) liefern `description` direkt mit.

## Betroffene Dateien

| Datei | Rolle |
|---|---|
| `frontend/src/components/FullscreenOverlay.vue` | Play/Pause-Button, Auto-Advance-Timer, Datums-Banner, Beschreibungs-Caption, `markDayChanges`-Prop |
| `frontend/src/utils/slideshow.ts` | Reine Logik: `shouldArmSlideshow`, `slideshowReachedEnd`, `isDayChange`, `shouldShowCaption` |
| `frontend/src/utils/slideshow.test.ts` | Unit-Tests der Logik |
| `frontend/src/components/TripMap.vue` | `allStopPhotos`: ganzer Trip als Vollbild-Scope (`open-fullscreen`) |
| `frontend/src/views/AlbumDetailView.vue` | Map-Overlay: `:markDayChanges="true"`, Stopp-Sync beim Schließen |
| `frontend/src/views/SharedAlbumView.vue` | Overlay: `:markDayChanges="fullscreenFromMap"` |

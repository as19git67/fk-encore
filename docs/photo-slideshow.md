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
- **Tastatur:** `S` startet/pausiert die Diashow (überall, wo sie verfügbar
  ist; nicht beim Tippen in Eingabefeldern).
- **Icon = Klick-Aktion:** Das Icon zeigt immer, was der Klick auslöst – ▶
  (`pi-play`) wenn gestoppt, ⏸ (`pi-pause`) während sie läuft. Jeder echte
  Stopp setzt `playing = false`, sodass das Icon stets stimmt.
- **Einstellbarer Abstand (user-spezifisch):** Auswahl zwischen
  **3 / 5 / 10 / 15 / 20 / 30 s** (Default **5 s**). Die Bedienung ist
  eingabeabhängig:
  - **Desktop / Maus (hover-fähig):** ein reines Caret-Dropdown (`Select`, nur
    der Pfeil) neben dem Play-Button. Der gewählte Wert wird nicht inline
    angezeigt, sondern erscheint im Tooltip bzw. im aufgeklappten Menü.
  - **Touch / Mobile (`(hover: none), (pointer: coarse)`):** der Caret entfällt;
    stattdessen öffnet ein **Long-Press (~450 ms) auf den Play-Button** ein
    Popup-Menü (`Menu`) mit den Zeitoptionen (aktueller Wert mit Häkchen). Ein
    kurzer Tap startet/pausiert wie gewohnt; der ausgelöste Long-Press wird vom
    folgenden Klick „verschluckt", sodass er nicht zusätzlich togglet. Da die
    Geste unsichtbar ist, erscheint **beim ersten Mal** ein einmaliger Hinweis
    („Play lange drücken, um das Diashow-Intervall zu wählen") als Sprechblase
    über der Action-Bar; er verschwindet nach 5 s, bei Antippen oder sobald der
    Play-Button gedrückt wird. Die „gesehen"-Flag liegt in `localStorage`
    (`slideshow_longpress_hint_seen`).

  Der Wert wird **pro Browser** in `localStorage` (`slideshow_interval_ms`)
  gespeichert; Logik in `frontend/src/utils/slideshowInterval.ts`. Die
  `autoAdvanceMs`-Prop schaltet die Diashow nur **ein** (Wert > 0) und dient als
  Fallback-Default.
- **Intervall & Idle-Reset:** Während des Laufs wird alle (eingestellten)
  Sekunden zum nächsten Foto weitergeschaltet. Jede Interaktion
  (Pointer/Tastatur/Wheel) setzt das Intervall zurück, sodass erst nach kurzer
  Ruhe weitergeschaltet wird. Zwischen zwei Fotos wird gewartet, bis das
  nächste Bild geladen ist (`playing` bleibt dabei `true`).
- **Details-Flyout pausiert nicht:** Bei geöffneter Detail-Ansicht läuft die
  Diashow weiter (die Beschreibung steht dort ohnehin in der Seitenleiste).
- **Stopps (Icon → ▶):** letztes Foto erreicht (kein Wrap-around), Öffnen des
  Transform-Editors (Bearbeiten), und das Schließen des Vollbilds.

Die reine Entscheidungslogik ist in `frontend/src/utils/slideshow.ts`
ausgelagert (`shouldArmSlideshow`, `slideshowReachedEnd`) und unit-getestet; die
Komponente besitzt nur Timer und `playing`-State und setzt `playing = false` bei
echten Stopps (Listenende, Editor öffnen).

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

## iOS (`ios/`, Issue #767 Etappe 2)

Die iOS-App hat die Diashow im Vollbild-Viewer (`PhotoFullscreenView`). Die
Entscheidungslogik liegt — analog zum Web — in einer eigenen, unit-getesteten
Datei (`Slideshow.swift` / `SlideshowTests.swift`), die View besitzt nur Timer
und `isPlaying`-Flag.

Gleich wie im Web:

- **Kein Auto-Start**, manuelles Play/Pause über die Bottom-Bar.
- **Intervall 3 / 5 / 10 / 15 / 20 / 30 s**, Default 5 s, pro Gerät
  gespeichert (`UserDefaults`-Key `slideshow_interval_seconds`; das Web nutzt
  `localStorage` — beide sind bewusst unabhängig, es gibt keinen Server-Sync).
  Ein gespeicherter Wert außerhalb der Optionen fällt auf den Default zurück.
- **Kein Wrap-around:** Am letzten Foto endet die Diashow und das Icon springt
  zurück auf ▶.
- **Details pausieren nicht**, blenden aber die Caption aus.
- **Beschreibungs-Caption** einzeilig mit Ellipsis über dem Bild, nur während
  des Laufs und nur bei nicht-leerer Beschreibung.
- **Warten auf das geladene Bild** (`currentLoaded`): Der Timer startet erst,
  wenn das aktuelle Foto steht, damit die Wartezeit die Betrachtungszeit ist
  und nicht am Platzhalter verstreicht. `ThumbnailLoader.onLoadSettled` meldet
  das Ende eines Ladeversuchs, `PhotoPageView` reicht die Foto-ID nach oben,
  `PhotoFullscreenView` sammelt sie in `settledPhotoIds`. Ein **fehlgeschlagener**
  Ladeversuch zählt dabei als geladen — sonst würde ein einziges kaputtes Bild
  die Diashow dauerhaft anhalten. Gewartet wird nur auf das Bild, nicht auf die
  Metadaten, die parallel laden.

Bewusst anders als im Web:

- **Bedienung über `Menu(primaryAction:)`:** Ein Tap startet/pausiert, ein
  Long-Press öffnet das Intervall-Menü. Das ist genau die Touch-Geste, die das
  Web für Mobilgeräte von Hand nachbaut — auf iOS ist sie nativ, deshalb
  entfällt der einmalige Long-Press-Hinweis samt „gesehen"-Flag.
- **Play ist am letzten Foto deaktiviert** statt sichtbar wirkungslos: ohne
  Wrap-around würde ein Start dort sofort wieder stoppen.
- **Kein Datums-Banner und kein Idle-Reset.** Beide hängen im Web an der
  Karten-/Trip-Ansicht bzw. an Pointer-/Wheel-Events; auf iOS gibt es dafür
  bisher keinen entsprechenden Einstiegspunkt. Offen, falls die Trip-Karte
  später ein durchlaufendes Vollbild bekommt.

Damit bleibt als inhaltlicher Unterschied zum Web nur noch der letzte Punkt.

## Betroffene Dateien

| Datei | Rolle |
|---|---|
| `frontend/src/components/FullscreenOverlay.vue` | Play/Pause-Button, Auto-Advance-Timer, Datums-Banner, Beschreibungs-Caption, `markDayChanges`-Prop |
| `frontend/src/utils/slideshow.ts` | Reine Logik: `shouldArmSlideshow`, `slideshowReachedEnd`, `isDayChange`, `shouldShowCaption` |
| `frontend/src/utils/slideshow.test.ts` | Unit-Tests der Logik |
| `frontend/src/components/TripMap.vue` | `allStopPhotos`: ganzer Trip als Vollbild-Scope (`open-fullscreen`) |
| `frontend/src/views/AlbumDetailView.vue` | Map-Overlay: `:markDayChanges="true"`, Stopp-Sync beim Schließen |
| `frontend/src/views/SharedAlbumView.vue` | Overlay: `:markDayChanges="fullscreenFromMap"` |
| `ios/Sources/FKPhotos/Features/Photos/Slideshow.swift` | iOS: reine Logik + Intervall-Optionen/Persistenz |
| `ios/Sources/FKPhotos/Features/Photos/PhotoFullscreenView.swift` | iOS: Play/Pause-Menu, Advance-Timer, Caption, `settledPhotoIds` |
| `ios/Sources/FKPhotos/Core/Storage/ThumbnailLoader.swift` | iOS: `onLoadSettled` / `isSettled` — Ladesignal für den Advance-Timer |
| `ios/Tests/FKPhotosTests/SlideshowTests.swift` | iOS: Unit-Tests der Logik |

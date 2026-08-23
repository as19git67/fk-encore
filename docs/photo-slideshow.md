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

Auf iOS ist die Diashow **kein Modus des Vollbild-Viewers**, sondern ein eigener
Vollbild-Player (`PhotoSlideshowView`) — derselbe Story-Player, den die
Rückblicke schon nutzen (`RecapPlayerView`). Der Viewer selbst spielt nichts
mehr ab; sein Play-Button übergibt die Fotos an den Player.

Der Player zeigt ausschließlich das Bild:

- **Story-Fortschrittsleiste** oben, ein Segment pro Foto — ab einer
  gewissen Fotozahl ein durchgehender Balken, siehe unten.
- **Tippen links** = ein Bild zurück, **tippen rechts** = weiter.
- **Langes Drücken** pausiert, solange der Finger liegt.
- **Nach unten wischen** oder ✕ schließt.
- **Ken-Burns-Bewegung** pro Bild plus Überblendung zwischen den Slides.
- **Warten auf das geladene Bild:** Solange ein Foto der aktuellen Slide noch
  lädt, steht der Fortschritt still — die Anzeigedauer ist Betrachtungszeit,
  nicht Ladezeit. Ein **fehlgeschlagener** Ladeversuch zählt als geladen, sonst
  würde ein einziges kaputtes Bild die Diashow dauerhaft anhalten.
- **Intervall 3 / 5 / 10 / 15 / 20 / 30 s**, Default 5 s, pro Gerät gespeichert
  (`UserDefaults`-Key `slideshow_interval_seconds`; das Web nutzt `localStorage`
  — beide sind bewusst unabhängig, es gibt keinen Server-Sync). Ein
  gespeicherter Wert außerhalb der Optionen fällt auf den Default zurück.
  Umgestellt wird er über das Timer-Menü in der Kopfzeile des Players.
  Rückblicke behalten ihre feste Taktung von 4 s.
- **Hintergrundmusik** wie im Rückblick (Lautsprecher-Button stummschalten,
  ⏩ wechselt den Track) — siehe unten.
- **Beschreibungs-Caption** unten, zweizeilig, nur bei nicht-leerer
  Beschreibung. Bei einem Foto-Paar gewinnt die erste vorhandene Beschreibung.
- **Herz-Button** markiert das Gezeigte als Favorit — bei einem Paar beide
  Fotos, weil sich der Tap auf das bezieht, was auf dem Schirm steht.
- **Kein Wrap-around:** Nach dem letzten Foto endet der Player und schließt sich.

### Woher die Fotos kommen

| Einstieg | Umfang |
|---|---|
| Überlaufmenü „Diashow" in `AlbumDetailView` | alle angezeigten Album-Fotos |
| Play-Button in der Auswahl-Toolbar (Album, Mediathek, Monat, gefilterte Timeline) | die ausgewählten Fotos |
| Play-Button in der Toolbar ohne Auswahl | alles, was die Ansicht gerade zeigt |
| Play-Button in der Bottom-Bar von `PhotoFullscreenView` | ab dem gezeigten Foto bis zum Ende |

Der Einstieg ist überall ab **zwei** Fotos sichtbar/aktiv — für ein einzelnes
gibt es nichts weiterzuschalten.

### Zwei Bilder pro Slide (auch im Rückblick)

Ein Querformat-Foto füllt auf einem hochkant gehaltenen Handy nur ein Band in
der Mitte. Deshalb legt der Player **zwei Querformat-Fotos übereinander** auf
eine Slide, wenn das Gerät im Hochformat ist — und **zwei Hochformat-Fotos
nebeneinander**, wenn es quer gehalten wird. Die beiden Hälften fahren dabei
von den gegenüberliegenden Rändern ein; einzelne Bilder blenden weiterhin über.
Fast quadratische Fotos (±5 %) werden nie gepaart, weil ein Paar dort genauso
viel Fläche verschenkt wie ein Einzelbild.

Die Ausrichtung ist erst bekannt, wenn ein Bild dekodiert ist. Der Plan wird
deshalb **inkrementell** gebaut (`SlideshowPlanner.extend`): Er legt so viele
Slides fest, wie er entscheiden kann, und wartet am ersten Foto, dessen Partner
noch fehlt. Bereits gezeigte Slides werden nie umnummeriert. Wartet der Player
länger als 2 s auf ein Bild, gibt er **für dieses eine Foto** auf und zeigt es
einzeln — der Rest wird danach wieder normal geplant. Dreht der Nutzer das
Gerät, bleibt der bereits gespielte Teil stehen und nur der Rest wird neu
gruppiert.

Die Fortschrittsleiste hat deshalb ein Segment pro **Foto**, nicht pro Slide:
So behält sie ihre Form, während der Plan noch wächst; die beiden Segmente
eines Paares füllen sich gemeinsam.

### Fortschrittsleiste bei vielen Fotos

Ein Rückblick hat eine Handvoll Bilder, eine Diashow über ein ganzes Album
aber schnell mehrere hundert. Ein Segment pro Foto trägt so weit nicht:
Die Segmente werden zu unsichtbaren Haarlinien, und schlimmer noch, allein
die Abstände dazwischen werden breiter als der Bildschirm. Ein `HStack`,
der nicht passt, schrumpft nicht — er macht sein Elternelement breiter.
Damit wuchs die `ZStack` des Players mit, und das Foto darin wurde zur
Seite geschoben: Bei 247 Fotos auf einem 402 pt breiten Gerät brauchte die
Leiste 984 pt nur an Abständen, und vom Bild blieb ein 99 pt schmaler
Streifen am rechten Rand übrig.

`SlideshowProgressTrack` prüft deshalb zuerst, ob die Segmente überhaupt
passen (mindestens 6 pt pro Segment plus 4 pt Abstand). Passen sie nicht,
wird die Leiste zu **einem** durchgehenden Balken, der den Gesamtfortschritt
in Fotos zeigt (`SlideshowPlayback.overallFraction`) — ein Paar rückt ihn
doppelt so weit vor wie ein Einzelbild, noch ungeplante Fotos zählen als
ausstehend. Zusätzlich ist die `ZStack` des Players fest auf die
Bildschirmgröße genagelt, damit kein Overlay das Bild je wieder verschieben
kann.

### Chrome und die Kamera-Aussparung

Das Foto ist bewusst randlos: Der `GeometryReader` des Players ignoriert die
Safe Area, damit das Bild bis an jede Kante reicht. Die Bedienelemente dürfen
ihm dorthin **nicht** folgen — mit 12 pt Abstand zur *Bildschirmkante* lagen
Fortschrittsleiste und Albumname im Hochformat unter der Dynamic Island.
`SlideshowChromeInsets` legt sie deshalb wieder in die Safe Area: oben,
unten (Home-Indicator) und im Querformat auch seitlich, jeweils plus dem
eigenen Rand des Players von 12 pt. Der untere Wert kommt ohne diesen Rand,
weil die Aufrufer dort schon größere Abstände mitbringen (Caption 92 pt).

### Musik

Beide Player nutzen dieselbe Klasse `SlideshowMusic` (Tracks aus
`GET /recaps-music`, gestreamt über den `APIClient`, Endlosschleife, Einblenden
über 1,5 s, Lautstärke 0,55). Fehler bleiben still — ein Fehler-UI ist Musik
nie wert.

Unterschied zwischen den beiden:

| | Rückblick | Diashow |
| --- | --- | --- |
| Track-Vorschlag | vom Server (`GET /recaps/:id`, Feld `music`) | keiner — es gibt kein Album-„Mood" |
| Startpunkt | der vorgeschlagene Track, der Zyklus kehrt zu ihm zurück | der zuletzt gewählte Track, sonst der erste der Liste |
| Stummschaltung | pro Abspielvorgang | pro Gerät gemerkt (`slideshow_music_muted`) |

Eine Diashow wird viel beiläufiger gestartet als ein Rückblick, deshalb merkt
sie sich beide Entscheidungen (`slideshow_music_muted`,
`slideshow_music_track`): Wer einmal stummschaltet, bekommt auch beim nächsten
Mal Ruhe.

### Ken Burns und Gesichter

Die Ken-Burns-Bewegung ist pro Foto deterministisch aus der Foto-ID abgeleitet
(gleicher Hash wie im Web), damit ein Bild immer gleich driftet. Der
Gesichtsbezug hat zwei Stufen:

1. **Bildausschnitt:** Liegt ein serverseitiger Fokuspunkt vor (`auto_crop`,
   Gesichtsmitte, 0..1 normalisiert), wird der Füll-Crop dorthin verschoben —
   begrenzt durch den Überstand, analog zu CSS `object-position`. Ohne
   Fokuspunkt bleibt es beim geometrischen Zentrum.
2. **Bewegungsziel:** Das **herangezoomte** Ende der Fahrt liegt exakt auf
   diesem Fokuspunkt (Versatz 0), nur das weite Ende wandert zufällig. Die
   Bewegung läuft also immer auf das Gesicht zu (bzw. von ihm weg) statt
   ziellos zu driften. Fotos ohne Fokuspunkt behalten die rein zufällige
   Bewegung an beiden Enden.

`auto_crop` wird serverseitig gesetzt und ist nicht für jedes Foto vorhanden;
ohne Wert verhält sich die Bewegung wie vorher.

### Bewusst anders als im Web

- Der Web-Player ist ein Modus des `FullscreenOverlay` mit Play/Pause-Button;
  auf iOS ist er eine eigene Ansicht. Entsprechend gibt es dort kein
  Play/Pause-Icon, sondern Pause per Fingerdruck.
- **Foto-Paare und der Gesichtsbezug der Ken-Burns-Bewegung existieren bisher
  nur auf iOS.**
- **Kein Datums-Banner und kein Idle-Reset.** Beide hängen im Web an der
  Karten-/Trip-Ansicht bzw. an Pointer-/Wheel-Events; auf iOS gibt es dafür
  bisher keinen entsprechenden Einstiegspunkt.

## Betroffene Dateien

| Datei | Rolle |
|---|---|
| `frontend/src/components/FullscreenOverlay.vue` | Play/Pause-Button, Auto-Advance-Timer, Datums-Banner, Beschreibungs-Caption, `markDayChanges`-Prop |
| `frontend/src/utils/slideshow.ts` | Reine Logik: `shouldArmSlideshow`, `slideshowReachedEnd`, `isDayChange`, `shouldShowCaption` |
| `frontend/src/utils/slideshow.test.ts` | Unit-Tests der Logik |
| `frontend/src/components/TripMap.vue` | `allStopPhotos`: ganzer Trip als Vollbild-Scope (`open-fullscreen`) |
| `frontend/src/views/AlbumDetailView.vue` | Map-Overlay: `:markDayChanges="true"`, Stopp-Sync beim Schließen |
| `frontend/src/views/SharedAlbumView.vue` | Overlay: `:markDayChanges="fullscreenFromMap"` |
| `ios/Sources/FKPhotos/Features/Photos/PhotoSlideshowView.swift` | iOS: Story-Player über Album/Auswahl/Mediathek |
| `ios/Sources/FKPhotos/Features/Recaps/RecapPlayerView.swift` | iOS: derselbe Player für Rückblicke (plus Musik/Intros) |
| `ios/Sources/FKPhotos/Features/Photos/SlideshowPlan.swift` | iOS: reine Logik — Ausrichtung, Paar-Planung, Playback-Position |
| `ios/Sources/FKPhotos/Features/Photos/SlideshowStage.swift` | iOS: Darstellung einer Slide (einzeln/Paar), Ken-Burns-Bewegung, Fortschrittsleiste |
| `ios/Sources/FKPhotos/Features/Photos/SlideshowImageStore.swift` | iOS: Vorausladen der Bilder + Ausrichtung nach dem Dekodieren |
| `ios/Sources/FKPhotos/Features/Photos/Slideshow.swift` | iOS: Intervall-/Musik-Persistenz + Caption-Regel |
| `ios/Sources/FKPhotos/Features/Photos/SlideshowMusic.swift` | iOS: Hintergrundmusik, geteilt von Diashow und Rückblick |
| `ios/Sources/FKPhotos/Features/Albums/AlbumDetailView.swift` | iOS: Menüpunkt „Diashow" und Auswahl-Diashow |
| `ios/Tests/FKPhotosTests/SlideshowPlanTests.swift` | iOS: Unit-Tests für Planung, Playback und Ken Burns |
| `ios/Tests/FKPhotosTests/SlideshowTests.swift` | iOS: Unit-Tests für Intervall und Caption |

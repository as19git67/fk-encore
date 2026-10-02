# Orientierungs-Varianten: Hoch- und Querformat desselben Motivs

Status: **In Umsetzung** — Etappen 1–3 (Backend, Web Raster + Vollbild, Web Review, PR #1421) und 4 (iOS Raster, Vollbild, Diashow) umgesetzt, Etappen 5–6 offen.

## Umsetzungsstand

- **Etappe 1 (Backend) — umgesetzt.** Migration `0225_orientation_variants`
  (`photo_groups.orientation_variants`, `users.collapse_orientation_variants`).
  Regel und Konstante in `photo/orientation-variants.ts`
  (`VARIANT_TIME_WINDOW_SECONDS = 120`, benannt wie `TIME_WINDOW_SECONDS` in
  `photo.service.ts`; der Plan sprach von `_MS`). Dort liegen die reine
  Funktion `computeOrientationVariants` und das SQL-Prädikat
  `orientationVariantSuppressedSql`, das `buildPhotoFilterConditions` für
  `variantMode=portrait|landscape` anwendet — damit gilt der Filter für
  `/gallery/grid`, `/gallery/ids`, `/photos` und `/photos/index`. Der
  Nutzer-Schalter und ein `off` an der Gruppe stecken im SQL, kein Aufrufer
  muss sie nachschlagen. `GalleryGridEntry.orientation`, `Photo.orientation`,
  `GalleryGridGroup.variants`, `PhotoGroup.orientation_variants`/`variants`,
  `ReviewQueueGroup.orientation_pair`. Cover-Wahl: zeigt das Raster nur eine
  Seite und liegt das Cover auf der anderen, trägt das bestplatzierte Mitglied
  der gezeigten Seite `is_cover` (die Datenbank bleibt unberührt). Endpunkte:
  `PATCH /photos/groups/:id/variants` (`{ mode: 'auto' | 'off' }`),
  `GET`/`PATCH /photos/groups/orientation-variants` (`{ enabled }`). Tests in
  `photo/orientation-variants.test.ts` (Zeitfenster, Sichtbarkeit, `off`,
  Schalter, Fremdgruppe, Cover, Review-Queue) und `photo.filters.test.ts`.
- **Etappe 2 (Web Raster + Vollbild) — umgesetzt.** `GalleryGridGroup.variants`
  trägt zusätzlich zu den Zählern die Foto-IDs je Seite (`portrait_ids`,
  `landscape_ids`, bestplatziert zuerst), damit der Viewer die Gegenseite
  ohne zweite Abfrage kennt. Im Web: `composables/useScreenOrientation.ts`
  (eine Quelle für die Bildschirm-Orientierung), `utils/orientationVariants.ts`
  (Seite eines Eintrags, Gegenseite, `variantModeFor`, `shouldSwitchSide`,
  `nextIndexSkippingCounterparts`), `composables/useVariantCursor.ts`
  (Gegenseite neben `cursorPhoto`, `toggle` mit `pinned`, Wechsel bei
  Drehung). `VirtualGallery` lädt mit `variantMode=<Orientierung>` und bei
  Drehung neu um den sichtbaren Anker, im Auswahlmodus und mit dem
  Filter-Schalter „Formatvarianten anzeigen" (`showVariants` in der URL,
  Chip „Inkl. Formatvarianten") mit `all`. Format-Badge (`.vg-variant-badge`,
  Icon `pi pi-sync`) in derselben Ecke wie das Stapel-Badge, Tipp öffnet das
  Vollbild auf der Gegenseite (`variant-click`). `FullscreenOverlay`: Prop
  `variantPhoto`, Knopf „Querformat"/„Hochformat" mit `R`, Event
  `toggle-variant`, Gegenseite wird vorgeladen; die Überblendung ist der
  bestehende Fade-in beim Laden. `PhotoDetailSidebar` zeigt den Dateinamen der
  Gegenseite. Blättern überspringt die Gegenseite, wenn die Liste beide Seiten
  hält. Der Nutzer-Schalter sitzt im Profil neben „Ähnliche Fotos" (Karte
  „Hoch- und Querformat"). Stories: `VirtualGallery.stories.ts` (Quer, Hochkant,
  beide Seiten, Auswahlmodus) und zwei Formatpaar-Stories im
  `FullscreenOverlay` mit `testViewport`. Tests: `useScreenOrientation`,
  `useVariantCursor`, `orientationVariants`.
- **Etappe 3 (Web Review) — umgesetzt.** Backend:
  `POST /photos/groups/:id/keep-best-per-orientation` (`bestPerOrientation`
  in `orientation-variants.ts`, läuft über `acceptAiPickLogic`, Favoriten
  bleiben geschützt), Review-Queue-Filter `orientationPair=true` über das
  SQL-Prädikat `groupIsOrientationPairSql` (ohne den Nutzer-Schalter: ob zwei
  Bilder ein Paar sind, ist eine Eigenschaft der Gruppe). Web:
  `ReviewQueueView` mit Chip „Formatpaare" (`pairs` in der URL), Tag
  „Hoch + Quer", Knopf „Bestes je Format behalten" und „Nicht dasselbe
  Motiv" / „Als Formatpaar behandeln" direkt an der Karte.
  `PhotoCompareView`: in einem Formatpaar duellieren sich nur Fotos derselben
  Orientierung (`allowedDuel`), das beste Foto je Seite wird nie zum
  Ausblenden vorgeschlagen (`bestPerSide`), und das Abschlussraster trägt den
  Hinweis „bleiben als Formatpaar erhalten" mit dem Schalter „Nicht dasselbe
  Motiv". `ReviewQueuePhoto.width/height` sind im Frontend-Typ deklariert.
  Stories: Review-Queue mit Formatpaar und mit aktivem Chip, Vergleich als
  Formatpaar.
- **Etappe 4 (iOS Raster, Vollbild, Diashow) — umgesetzt.**
  `Core/Models/OrientationVariants.swift` (`PhotoOrientation`,
  `OrientationVariants` mit Seite/Gegenseite je Foto, `VariantMode.forScreen`,
  `OrientationVariantRules.shouldSwitchSide`, `SlideshowVariants`) und
  `Core/UI/ScreenOrientationEnvironment.swift` (`@Environment(\.screenOrientation)`,
  einmal in `MainTabView` über `.providesScreenOrientation()` gesetzt, plus
  `VariantBadge`). `PhotoWithCuration`/`Photo` tragen `orientation`,
  `AlbumGroupReview.Group` trägt `orientation_variants` und `variants`.
  `PhotosViewModel` lädt `/photos` mit `variantMode` und parallel
  `/photos/groups`, woraus `variantsByPhotoId` entsteht. `PhotoGridView`:
  Seite nach Bildschirm, `all` im Auswahlmodus oder mit dem Filter
  „Formatvarianten anzeigen" (`PhotoFilter.showVariants`, Schalter im
  `FilterSortMenuView`), Neuladen bei Drehung um die oberste sichtbare Kachel,
  Badge oben rechts öffnet den Viewer auf der Gegenseite.
  `PhotoFullscreenView`: Gegenseite wird je Seite nachgeladen
  (`PhotoFetch.byId`) und **an Ort und Stelle** gezeigt (Seitenindex bleibt),
  Knopf in der unteren Leiste, Drehen wechselt automatisch, ein manueller
  Wechsel pinnt die Seite. `PhotoSlideshowView`: Gegenseiten einmal per
  `PhotoFetch.byIds` holen, die Gegenseite eines früheren Fotos aus der Folge
  streichen, je Bildschirm-Orientierung die passende Seite einsetzen (Indizes
  bleiben stabil), erst dann paart `SlideshowPlanner` den Rest. Tests in
  `OrientationVariantsTests.swift`. Nicht gemacht: zweiter Dateiname in der
  iOS-Detailansicht; der Nutzer-Schalter liegt nur im Web-Profil. Ohne Xcode
  in dieser Umgebung ist der Swift-Code nicht kompiliert worden.
- Etappen 5–6 offen; die album-gebundene Liste läuft über `/gallery/grid`
  mit `albumScopeId` und ist damit abgedeckt, die anonyme Link-Ansicht hat
  keinen Nutzer (und damit keine Gruppen) und bleibt außen vor. Die Diashow
  im Web läuft über dasselbe `cursorPhoto`, der Drehungswechsel greift also
  auch dort; eine eigene Seitenwahl pro Schritt in `utils/slideshow.ts` ist
  erst nötig, wenn die Liste beide Seiten hält.

## Problem

Vom selben Motiv gibt es oft ein Hoch- und ein Querformat, wenige Sekunden
auseinander aufgenommen. Beide sind gewollt (der KI-Pick hält sie über die
Orientierungs-Diversität bewusst beide), aber in jeder Ansicht stehen sie
nebeneinander, und auf einem gedrehten Bildschirm passt immer eines von beiden
schlecht: im Vollbild hochkant bleibt vom Querformat ein Streifen, in der
Diashow quer bleibt vom Hochformat eine Säule.

## Idee in einem Satz

> Fotos, die dasselbe Motiv in beiden Formaten zeigen, bilden eine
> **Formatgruppe**. Jede Ansicht zeigt davon nur die Seite, die zur aktuellen
> Bildschirm-Orientierung passt; die andere Seite ist einen Tipp (oder eine
> Drehung des Geräts) entfernt.

Die Formatgruppe ist eine **Ansicht**, kein Ausblenden: nichts wird in
`photo_curation` geschrieben, Zähler bleiben ehrlich, und sobald der Nutzer
auswählt oder löscht, ist alles sichtbar.

## Datenmodell

### Woher die Formatgruppe kommt

Nichts Neues clustern. Die Ähnlichkeitsgruppen (`photo_groups`, DINOv2 ≥ 0.90
im 10-Minuten-Fenster, pro Nutzer) liefern schon „dasselbe Motiv". Eine
Formatgruppe ist die Teilmenge einer Ähnlichkeitsgruppe, die

- mindestens ein `portrait`- und ein `landscape`-Mitglied hat
  (`classifyOrientation` aus `photo/group-auto-pick.ts`, `square` zählt nie),
- deren Mitglieder für diesen Nutzer sichtbar sind (nicht `hidden`),
- und bei der die beiden Formate höchstens `VARIANT_TIME_WINDOW` (Vorschlag
  120 s) auseinanderliegen. Das engere Fenster trennt „zwei Formate derselben
  Aufnahme" von „ich war zehn Minuten am selben Ort".

Weil `photo_groups` pro Nutzer sind und Sichtbarkeit pro Nutzer ist, ist die
Formatgruppe automatisch pro Nutzer. Fotos ohne `width`/`height` (Backfill
„Bildmaße nachtragen" fehlt) bilden nie eine Formatgruppe.

Reviewte und unreviewte Gruppen verhalten sich verschieden:

| Gruppe | heute | mit Formatgruppe |
|---|---|---|
| unreviewt | Stapel, nur das Cover sichtbar | Stapel bleibt; als Cover wird das Mitglied gezeigt, das zur Orientierung passt (Fallback: bisheriges Cover) |
| reviewt, beide Formate behalten | alle behaltenen Fotos nebeneinander | nur die Seite der aktuellen Orientierung; die andere Seite hinter einem Format-Badge |
| reviewt, ein Format behalten | ein Foto | unverändert |

### Persistenz

Keine neue Tabelle. Zwei Ergänzungen:

| Spalte | Tabelle | Bedeutung |
|---|---|---|
| `orientation_variants` | `photo_groups` | `'auto'` (Standard, berechnet), `'off'` (Nutzer: „nicht dasselbe Motiv", Formatgruppe gilt nie), NULL = nicht geprüft |
| `collapse_orientation_variants` | `users` | globaler Schalter, Default `TRUE` |

Die Mitgliedschaft selbst wird beim Lesen berechnet (Orientierung, Sichtbarkeit
und Zeitfenster liegen alle schon in der Abfrage von `listPhotoGroupsLogic`
bzw. `/gallery/grid`). Materialisieren wäre erst nötig, wenn das Lesen zu teuer
wird; die Zahl der Gruppen mit beiden Formaten ist klein.

### API

- `GalleryGridEntry` und `Photo` bekommen `orientation: 'portrait'|'landscape'|'square'|null`.
- `GalleryGridGroup` bekommt `variants?: { portrait: number; landscape: number }`.
- `/gallery/grid` (und die album-/link-gebundenen Listen) lernen den Filter
  `variantMode=all|portrait|landscape`. Der Server lässt bei `portrait` die
  Querformate jeder Formatgruppe weg und umgekehrt; `all` zeigt alles. Der
  Filter lebt in `photo/photo.filters.ts` neben `hiddenMode`. Server-seitig
  deshalb, weil das Raster server-paginiert ist und ein Client-Filter Lücken
  in Offsets und Zählern risse.
- `PATCH /photos/groups/:id/variants` mit `{ mode: 'auto' | 'off' }`.
- `ReviewQueueGroup` bekommt `orientation_pair: boolean`, und
  `ReviewQueuePhoto.width/height` werden im Frontend-Typ endlich deklariert.

## Verhalten in den Ansichten

Die Bildschirm-Orientierung kommt im Web aus `useMediaQuery('(orientation: portrait)')`
(`composables/useBreakpoint.ts`), in iOS aus `GeometryReader` wie in
`PhotoCompareView.swift`. Beide Apps halten sie in **einem** Composable bzw.
einer Umgebungsgröße (`useScreenOrientation` / `@Environment(\.screenOrientation)`),
nicht in jeder View neu.

### Raster (Alle Fotos, Album, geteiltes Album, iOS-Raster)

- Die Liste lädt mit `variantMode=<aktuelle Orientierung>`. Dreht sich der
  Bildschirm, lädt sie neu und hält die Scroll-Position über den
  `listAnchor` (Issue #1279), der ohnehin existiert.
- Das gezeigte Foto trägt ein kleines Format-Badge (Icon „Drehen", Tooltip
  „Auch im Querformat vorhanden"). Es sitzt neben dem Stapel-Badge, in derselben
  Ecke und Größe (`.vg-stack-badge` in `VirtualGallery.vue`). Tipp auf das
  Badge öffnet das Vollbild direkt mit der **anderen** Seite.
- Im **Auswahlmodus** ist `variantMode=all`: wer auswählt, löscht oder in den
  Basket legt, sieht alles. Keine Aktion trifft etwas Unsichtbares.
- Der Filter „ausgeblendete Fotos" bekommt die Option **„Formatvarianten"**
  (analog zu „übernommen"), damit man jederzeit sehen kann, was zusammengefasst
  ist.

### Vollbild / Fullscreen (Web `FullscreenOverlay`, iOS `PhotoFullscreenView`)

- Der Viewer kennt zu jedem Foto seine Gegenseite. Ein Knopf „Querformat" /
  „Hochformat" (Icon Drehen, Tastatur `R`) wechselt zur Gegenseite an Ort und
  Stelle, Index in der Liste bleibt.
- **Drehen des Geräts wechselt automatisch** auf die passende Seite, mit
  Überblendung. Das ist das sichtbare Versprechen des Features: man dreht das
  Telefon, und das Bild ist plötzlich das hochkant aufgenommene. Wer gerade
  bewusst die Gegenseite gewählt hat, wird beim Drehen nicht überstimmt (ein
  manueller Wechsel setzt ein `pinned`-Flag bis zum nächsten Foto).
- Blättern überspringt die Gegenseite (sie ist Teil des aktuellen Fotos, kein
  eigener Schritt). Die Detail-Seitenleiste zeigt beide Dateinamen.

### Diashow

- Web: `utils/slideshow.ts` wählt pro Schritt die passende Seite; bei
  Drehung mitten in der Diashow wechselt das aktuelle Bild sofort.
- iOS: `SlideshowPlanner` paart heute zwei Querformate auf dem hochkanten
  Bildschirm. Mit Formatgruppen ist die erste Regel: passende Seite nehmen,
  und erst dann paaren, was übrig bleibt. Die Orientierung des Fotos kommt dann
  aus der API statt aus der dekodierten Bildgröße.

### Rückblicke und Stream

Rückblick-Player und Feed-Karte zeigen ein Foto groß; sie nehmen dieselbe
Hilfsfunktion „passende Seite zur Orientierung" und sind damit mit abgedeckt.
Keine eigene Logik, nur eine Etappe später.

## Gruppen-Review

Das Review ist der Ort, an dem die Formatgruppe **bestätigt** wird: wer eine
Gruppe fertig reviewt und beide Formate behält, hat gesagt „das ist ein Motiv in
zwei Formaten". Deshalb drei Änderungen:

1. **Nicht gegeneinander antreten lassen.** Hoch- gegen Querformat zu
   vergleichen ist die falsche Frage. In `PhotoCompareView` (Web) duellieren
   sich zuerst die Fotos *innerhalb* einer Orientierung; im Abschlussraster
   stehen die Sieger beider Formate als verbundenes Paar mit dem Hinweis
   „bleiben als Formatpaar erhalten". iOS `CompareTournament.suggestedKeepIds`
   macht das für die Vorauswahl schon, die Duell-Reihenfolge noch nicht.
2. **Eine Aktion „Bestes je Format behalten".** In der Review-Queue (Web-Karte
   und iOS-Wischen) neben „KI-Pick übernehmen": behält pro Orientierung das
   bestbewertete Foto und markiert reviewt. Für Gruppen mit genau einem Foto je
   Format ist es dasselbe wie „Alle behalten", nur mit der Aussage „Formatpaar".
   Als iOS-Wischgeste bietet sich *unten* an (rechts, links, hoch sind belegt).
3. **Eine Aktion „Nicht dasselbe Motiv".** Im Review und in der Seitenleiste
   der Gruppe: setzt `orientation_variants='off'`. Ab da werden beide Fotos
   überall nebeneinander gezeigt. Umgekehrt stellt „Als Formatpaar behandeln"
   `auto` wieder her. Kein Dialog, beides sofort rückgängig machbar.

Die Review-Queue bekommt einen Filter-Chip **„Formatpaare"** und zeigt auf der
Karte das Tag „Hoch + Quer". KI-Auto-Pick bleibt wie er ist: die
Orientierungs-Diversität tut genau das Richtige, und der neue Zustand macht
nur sichtbar, warum die KI zwei Fotos behalten hat.

Übernahme fremder Reviews (`docs/group-review-adoption.md`) überträgt
`orientation_variants` **nicht**: ob zwei Bilder dasselbe Motiv sind, ist
objektiv genug, dass `auto` für alle gilt; ein `off` ist eine persönliche
Entscheidung an der eigenen Gruppe.

## Was bewusst nicht passiert

- Kein Schreiben in `photo_curation`. Die Gegenseite ist nicht „ausgeblendet",
  sie ist nur gerade nicht an der Reihe. Alle ~20 Abfragestellen, die
  `hidden` auswerten, bleiben unangetastet.
- Keine Zählerkorrektur: „120 Fotos" bleibt 120, auch wenn das Raster 110
  Kacheln zeigt. Das Badge erklärt die Differenz an Ort und Stelle.
- Keine Formatgruppe über Gruppengrenzen hinweg und kein eigener
  Clustering-Lauf.
- Der Schalter `collapse_orientation_variants` steht unter Fotos ›
  Einstellungen; wer das Verhalten nicht will, hat alles wie heute.

## Etappen

1. **Backend**: `orientation` in `Photo`/`GalleryGridEntry`, Formatgruppe in
   `listPhotoGroupsLogic`, `variantMode`-Filter, Cover-Wahl nach Orientierung,
   `orientation_variants`-Spalte + Endpoint, Nutzer-Schalter, Tests für
   Zeitfenster, Sichtbarkeit und `off`.
2. **Web Raster + Vollbild**: `useScreenOrientation`, Neuladen bei Drehung mit
   Anker, Format-Badge, Gegenseite im `FullscreenOverlay` (Knopf, `R`,
   Auto-Wechsel bei Drehung, `pinned`), Filteroption, Auswahlmodus = `all`,
   Storybook-Stories für Badge und Overlay in beiden Orientierungen
   (`testViewport`).
3. **Web Review**: Duelle innerhalb der Orientierung, Formatpaar im
   Abschlussraster, „Bestes je Format behalten", „Nicht dasselbe Motiv",
   Chip „Formatpaare".
4. **iOS Raster, Vollbild, Diashow**: Umgebungswert für Orientierung,
   Badge, Gegenseite im `PhotoFullscreenView`, `SlideshowPlanner` nimmt die
   passende Seite vor dem Paaren.
5. **iOS Review**: Wischgeste „Bestes je Format", Kontextmenü „Nicht dasselbe
   Motiv", Duell-Reihenfolge in `CompareTournament`.
6. **Rückblicke und Stream** mit derselben Hilfsfunktion.

## Entscheidungen

Die drei anfangs offenen Fragen sind mit dem Nutzer entschieden:

- **Zeitfenster 120 s** zwischen den beiden Formaten, als Konstante
  `VARIANT_TIME_WINDOW_MS` neben `TIME_WINDOW_MS`. Das volle Gruppenfenster
  von zehn Minuten gilt nicht.
- **Seite zeigen, nicht paaren.** Hat der Nutzer mehrere Fotos je Format
  behalten (3 hoch, 2 quer), zeigt die Ansicht alle Fotos der passenden
  Seite; die andere Seite liegt gesammelt dahinter. Keine 1:1-Zuordnung.
- **Drehen wechselt automatisch** im Vollbild und in der Diashow, mit
  Überblendung. Ein manueller Wechsel setzt `pinned` bis zum nächsten Foto
  und wird vom Drehen nicht überstimmt.

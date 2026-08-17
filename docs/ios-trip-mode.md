# iOS Trip Mode – Feature-Plan

Stand: 2026-07-24 · Status: Entwurf (Entscheidungen 1–4 gesperrt)

## 1. Ziel & Kernidee

Ein Toggle „Trip Mode". Ist er an, werden neue auf dem iPhone gemachte Fotos
automatisch in ein fk-encore-Album synchronisiert — **ohne** dass vorher ein
Album angelegt werden muss (weder in iOS noch in fk-encore). Die App legt ein
iOS-Album automatisch an, füllt es mit den neuen Trip-Fotos und synct es. Für
Gruppenreisen kann leicht ein gemeinsames, geteiltes Album verwendet werden.

**Zentrale Erkenntnis:** ~80 % existiert bereits. Trip Mode ist eine
Orchestrierungsschicht über der Album-Sync-Maschinerie
(`makeAvailable` → `albumMappings` / `albumSyncModes` / Watermark-Upload /
bisync-Download / `albumShares` / Push). Wirklich **neu** ist nur ein
Mechanismus: neue Fotos automatisch in ein iOS-Album *legen* (heute kuratiert
das der Nutzer von Hand in Fotos.app).

## 2. Gesperrte Entscheidungen

1. **Default-Modus solo = `sync`** (nicht bisync). Grund: `sync` propagiert
   iPhone-seitiges Aussortieren (Foto aus dem Album entfernt) auch zum
   Server-Album. bisync optional zuschaltbar.
2. **Trip-Mitgliedschaft = Zeitfenster** als Default, **Home-Ausschlusszone**
   als Verfeinerung. Ausdrücklich *keine* Zone um den Startort: ein Trip
   bewegt sich vom Start weg, die Entfernung zum Startort sagt nichts über die
   Zugehörigkeit eines Fotos aus.
3. **Geteilter Trip = `sync` als Default**, pro Nutzer auf bisync umschaltbar.
   Server-Album ist die gemeinsame Basis.
4. **Automatische Trip-Erkennung**: gewünscht (als Vorschlag), wenn sie
   einigermaßen zuverlässig funktioniert → eigene Etappe.

## 3. Wiederverwendung vs. Neu

| Baustein | Status |
|---|---|
| iOS↔Server-Album-Verknüpfung, Modus setzen | vorhanden (`LibraryBrowserViewModel.makeAvailable`) |
| Upload neuer Fotos, Watermark, Dedup | vorhanden (`PhotoSyncService`) |
| Aussortieren → Server-Entfernung (`sync`) | vorhanden (`syncAlbumDeletions`) |
| Server-Fotos aufs Gerät (bisync) | vorhanden (`PhotoDownloadService`) |
| Album teilen, Teilnehmer finden | vorhanden (`/albums/share`, `/albums/:id/shareable-users`) |
| Push/Notifications | vorhanden (sharedalbum-Service) |
| Trip-Erkennung (Home-Zentroid, Zeit/Geo-Cluster) | vorhanden für Recaps (`recaps.service.ts`) |
| **Neue Fotos automatisch ins iOS-Album legen** | **NEU** |
| **Trip-Metadaten (Start/Ende/aktiv) am Server** | **NEU (minimal)** |

## 4. Capture-Window-Mechanik (Herzstück)

Ein Trip ist ein Zeitfenster `[start, ende?]` (+ optional Geofence
lat/lon/radius). Der Auto-Add-Pass läuft überall dort, wo schon Sync läuft
(Foreground-Resume, Kaltstart, BG-Task) und zusätzlich reaktiv über
`PHPhotoLibraryChangeObserver`:

> Für jedes Bild-Asset mit `creationDate ≥ start` (und, falls Geofence gesetzt,
> innerhalb des Radius), **das noch nie behandelt wurde**, → ins Trip-iOS-Album
> legen und als behandelt markieren.

**Aussortieren-Reconciliation (kritisch wegen Entscheidung 1):** Auto-Add darf
nie „alle Fenster-Assets, die nicht im Album sind" nehmen — sonst würde ein
gerade ausgemistetes Foto sofort wieder eingefügt und der `sync`-Modus geriete
in einen Add/Remove-Konflikt samt Re-Upload. Stattdessen ein **`handledAssetIds`**
(bzw. High-Water-Mark auf `creationDate` + Randliste), exakt analog zum
Upload-Watermark: nur nie-behandelte Assets werden hinzugefügt. Entfernt der
Nutzer danach ein Foto aus dem Album, bleibt es entfernt und `sync` löscht es
serverseitig.

- **Auto-Modus:** behandelt = automatisch hinzugefügt.
- **Manueller Modus:** behandelt = hinzugefügt **oder** verworfen (`dismissed`).
  Kandidaten fürs Review-Grid = Fenster-Assets − behandelt.

Robust gegen App-Kills: Der Pass holt beim nächsten Lauf nach (idempotent),
passt zur Resilienz-Arbeit an `runFullSync`.

**Warum die Reconciliation überhaupt nötig ist (und heute nicht auftritt):** Die
aktuelle Implementierung hat **genau einen Schreiber** der Album-Mitgliedschaft
— den Nutzer (in Fotos.app). Der Sync *liest* die Mitgliedschaft nur und leitet
Upload/Löschung ab; er *fügt nie* etwas hinzu. Entfernt der Nutzer ein Foto,
propagiert `sync` das zum Server und nichts fügt es je wieder ein → kein
Konflikt. Trip Mode führt mit dem Auto-Add-Pass einen **zweiten, automatischen
Schreiber** ein — erst dadurch kann „aussortiert → sofort wieder eingefügt →
Re-Upload → …" entstehen. `handledAssetIds` (jedes Asset genau einmal anfassen)
stellt die „ein effektiver Schreiber"-Eigenschaft wieder her. Präzedenzfall: die
bisync-Download-Seite fügt schon heute Fotos ins iOS-Album (heruntergeladene
Server-Fotos) und trackt via `downloadedPhotos` / `forgetDownloadedPhotos`, was
sie hinzugefügt hat, genau um denselben Kampf mit dem Aussortieren zu vermeiden.
`handledAssetIds` ist das Upload-seitige Gegenstück.

## 5. Trip-Lebenszyklus

- **Start:** Zeitpunkt des Einschaltens (deterministisch, keine Fehlalarme).
- **Ort/Name:** aktuelle `CLLocation` beim Start holen, reverse-geocoden
  (geo/osm-admin) → Namensvorschlag „Gardasee (Juli 2026)", editierbar. Der
  Name wird zum Server-Album-Namen.
- **Home-Ausschlusszone (optional):** Home-Zentroid (`GET /trips/home-location`,
  dieselbe Quelle wie das Auto-Ende) + `homeArrivalRadiusMeters`; grenzt
  Mitgliedschaft ein (daheim während laufendem Trip gemachte Fotos fallen
  raus). Ohne bekannten Home-Ort gilt das reine Zeitfenster.
- **Ende:** Toggle-off (Standard). Später optional Auto-Ende (wieder länger in
  Home-Region) + Max-Dauer.
- **Toggle-off:** Auto-Add stoppt für *neue* Fotos. iOS-Album, Server-Album,
  Verknüpfung bleiben — der Trip wird ein normales verknüpftes Album, Modus
  weiter änderbar (bestehende Disconnect/Mode-Logik).
- **Nachlauf nach dem Ende (wichtig):** Der Trip wird beim Beenden **nicht
  verworfen**, sondern mit gesetztem `endedAt` in eine Liste beendeter Trips
  übernommen (`TripPreferences.loadClosedTrips`). Grund: Der Auto-Add-Pass
  sieht die Fotomediathek nur, während die App läuft — mit der Kamera-App
  aufgenommene Fotos werden regelmäßig erst später entdeckt, unter Umständen
  erst nach dem Toggle-off. Der Catch-up arbeitet solche Fotos noch nach.
  `endedAt` ist dabei die **harte Obergrenze**: Fotos, die nach dem Beenden
  entstanden sind, landen nie im Trip-Album. Nach Ablauf einer Karenzzeit
  (`TripMembership.closedTripGrace`, 24 h) fällt der beendete Trip aus der
  Liste.

## 6. Solo-Trip – Ablauf

1. Toggle an → App legt iOS-Album an, ruft `makeAvailable`-Logik
   (Server-Album per Namensabgleich finden/erstellen), Modus **sync**, confirm,
   `syncEnabled = true`, Watermark = jetzt.
2. Auto-Add-Pass legt neue Fotos ins Album, Sync lädt hoch.
3. Nutzer sortiert am iPhone aus → `syncAlbumDeletions` entfernt sie aus dem
   Server-Album (nur eigene Uploads, sicher).
4. Toggle aus → einfrieren.

## 7. Manueller Kurationsmodus (Option 5/6)

Schalter `autoAdd = false` im Trip. Neben dem Trip-Toggle ein Button →
Review-View: Grid aller neuen, noch nicht behandelten Trip-Kandidaten
(Fenster-Regel). Mehrfachauswahl → „Zum Trip-Album hinzufügen"
(+ optional „Jetzt synchronisieren"). Nicht ausgewählte können verworfen werden
(`dismissedAssetIds`), tauchen nicht wieder auf.

## 8. Geteilter Trip

Ein geteilter Trip = **ein geteiltes Server-Album mit koordiniertem
Lebenszyklus**, kein neues Sharing-Konzept. Jedes Mitglied hat sein eigenes
iOS-Trip-Album, das per **sync** ins gemeinsame Server-Album synct.

**Deletion-Sicherheit passt perfekt:** `syncAlbumDeletions` fasst nur Fotos an,
die *dieses Gerät* hochgeladen hat (`serverPhotoMap`). A kann also nur A's
eigene Fotos aus dem geteilten Album aussortieren, nie B's. Genau richtig.

- **Einladen (umgesetzt, Issue #918):** Der „Teilen"-Button in der aktiven
  Trip-Ansicht öffnet die reguläre `AlbumShareView` für das Trip-Server-Album:
  Teilnehmer aus `/albums/:id/shareable-users` mit `read` / `write` /
  `write_share` einladen oder einen öffentlichen Link erzeugen. Der
  Trip-spezifische Push („Anna hat dich zum Trip 'Gardasee' eingeladen") und
  die Empfänger-Provisionierung folgen weiterhin in Etappe 3.
- **Beitreten beim Einschalten:** Client fragt `GET /trips/active` (aktive
  Trips aus meinem Kreis) → Dialog „An Trip von Anna teilnehmen?". Bei Zusage:
  Provisionierung mappt das lokale iOS-Album **direkt auf die bekannte
  Server-Album-ID** (nicht über Namensabgleich!), Modus sync.
- **bisync optional:** Wer die Fotos aller anderen aufs Gerät will, schaltet pro
  Trip auf bisync (Speicher-Hinweis).

## 9. Automatische Trip-Erkennung (Vorschlag, Etappe 5)

Home-Distanz-Heuristik aus den Recaps geliehen (`computeHomeCentroid`): Ist der
Nutzer > X km vom Home-Zentroid für > Y Stunden → proaktiver Vorschlag „Sieht
aus, als wärst du unterwegs (Ort). Trip Mode einschalten?". Bewusst nur
Vorschlag, nie automatisch (Zuverlässigkeit/Akku).

**Stand: beide Richtungen sind umgesetzt** — §9.1 (Ende), §9.2 (Start) und die
Bremsen aus §9.3.

### 9.1 Auto-Ende-Vorschlag (umgesetzt)

Die spiegelbildliche Hälfte — „wieder länger in Home-Region → Trip beenden?"
— **ist umgesetzt**, unabhängig vom (noch offenen) Start-Vorschlag:

- **Server:** `GET /trips/home-location` (`photo/trips.ts`) liefert den
  Home-Zentroid des Nutzers, berechnet mit derselben
  `computeHomeCentroid`-Funktion wie die Recaps — Client und Server sind sich
  damit einig, wo „zuhause" ist. `null`, solange zu wenig Geodaten vorliegen.
- **Client:** `TripAutoEndMonitor` (Singleton, `@MainActor`) startet bei
  `TripStore.startTrip` und stoppt bei `endTrip`. Registriert
  `CLLocationManager.startMonitoringSignificantLocationChanges()` — läuft
  auch, während die App im Hintergrund oder (mit „Immer"-Berechtigung)
  beendet ist; das System weckt die App bei Bedarf, um das Update
  zuzustellen. `NSLocationAlwaysAndWhenInUseUsageDescription` in `Info.plist`
  begründet die zusätzliche Berechtigungsanfrage.
- **Heuristik (`TripAutoEndHeuristic`, pur/testbar):** Bleibt das Gerät
  ununterbrochen innerhalb von `homeArrivalRadiusMeters` (2 km — enger als
  ein typischer Trip-Geofence von 25 km, damit ein Trip in Heimatnähe nicht
  sofort als „beendet" erscheint) für mindestens `homeArrivalGrace` (2 h),
  wird der Vorschlag ausgelöst. Verlässt das Gerät den Radius zwischendurch,
  beginnt die Uhr neu. Nach einem Vorschlag greift `suggestionCooldown` (6 h),
  damit ein kurzer Einkauf in Heimatnähe nicht sofort erneut fragt.
- **Vorschlag erreicht den Nutzer auf zwei Wegen, beide aus `pendingSuggestion`
  gespeist (`TripAutoEndPreferences`):**
  1. Lokale Notification mit Aktionen „Trip beenden" / „Weiter unterwegs" —
     beantwortbar direkt von der Sperrbildschirm-Benachrichtigung aus, ohne
     die App zu öffnen (`AppDelegate.userNotificationCenter(_:didReceive:)`).
  2. Banner oben in `TripView`, falls die Notification nicht erlaubt,
     verpasst oder ignoriert wurde — erscheint beim nächsten Öffnen/
     Vordergrund-Wechsel der App.
  Beide Wege beenden den Trip nur nach expliziter Bestätigung; ein Antippen
  der Notification ohne Aktion oder „Weiter unterwegs" räumt den Vorschlag
  nur weg (Cooldown greift trotzdem, damit nicht sofort erneut gefragt wird).
- Fehlt die Standortberechtigung oder wird sie verweigert, läuft der Trip
  unverändert weiter — der Monitor ist eine reine Zusatzfunktion über dem
  bestehenden manuellen „Beenden"-Button in `TripView`.

#### 9.1.1 Warum der Vorschlag anfangs nie ankam (behoben)

Die erste Fassung wertete die Heuristik **ausschließlich in
`didUpdateLocations`** aus. Significant-Change-Updates liefert iOS aber nur bei
*Bewegung* — und „zuhause angekommen" heißt gerade, dass das Gerät stehen
bleibt. Praktisch: bei der Ankunft kam genau ein Update (Uhr startet,
`shouldSuggest == false`), danach lag das Telefon still, es kam nie wieder ein
Update, und der Moment „zwei Stunden ununterbrochen zuhause" wurde nie
ausgewertet. Der Vorschlag konnte so grundsätzlich nicht erscheinen.

Verschärfend kam hinzu, dass `resumeIfTripActive()` beim Start **jedes
Prozesses** `resetArrivalTracking()` aufrief. `isMonitoring` ist prozesslokal,
also lief das bei jedem Kaltstart — und der Significant-Change-Dienst startet
die App zum Zustellen von Updates selbst neu. Die Ankunftsuhr wurde damit genau
von dem Mechanismus zurückgesetzt, dessen Ablauf sie messen sollte.

Drei Änderungen beheben das:

1. **Vorausgeplante Benachrichtigung statt reaktiver Auswertung.** Die
   Heuristik liefert nicht mehr nur „jetzt vorschlagen: ja/nein", sondern den
   *Zeitpunkt*, ab dem gefragt werden darf (`armFireAt` — das spätere von
   Ablauf der Grace-Periode und Ende des Cooldowns). Bei Ankunft plant
   `TripAutoEndMonitor.arm(...)` dafür eine
   `UNTimeIntervalNotificationTrigger`-Notification ein. Die stellt das System
   selbstständig zu, auch wenn die App nie wieder läuft. Verlässt das Gerät den
   Radius, wird sie über `disarm()` zurückgenommen.
2. **Ankunftsuhr überlebt Neustarts.** `start(resetTracking:)` setzt den
   Zustand nur noch beim *Beginn* eines Trips zurück; `resumeIfTripActive()`
   übergibt `false`.
3. **Auswertung auch ohne Ortsupdate.** `evaluateNow()` prüft die letzte
   bekannte Position und läuft in `runFullSync()` mit — also bei App-Start,
   Foreground-Wechsel und Hintergrund-Task. Das trägt zusätzlich den Fall, dass
   überhaupt nur „Beim Verwenden"-Berechtigung erteilt wurde.

Die Notification-ID ist pro Trip stabil und wird für die geplante *und* die
sofortige Variante verwendet — dieselbe ID ersetzt die vorherige Anfrage, ein
Doppel-Nachfragen ist damit ausgeschlossen. Die reine Entscheidungslogik ist in
`TripAutoEndHeuristicTests` festgenagelt.

**Start und Ende sind bewusst kein Spiegelbild.** Beim Start läuft noch kein
Trip — hier ist ein CoreLocation-Dauerbetrieb mit „Immer"-Berechtigung nicht
zu rechtfertigen wie beim (bereits laufenden, explizit gestarteten) Trip oben.
Der Start-Vorschlag nutzt stattdessen ein Signal, das ohnehin schon kostenlos
anfällt: die GPS-Koordinaten neuer Fotos aus dem Auto-Add-/Sync-Pass.

### 9.2 Start-Vorschlag (umgesetzt)

`TripAutoStartMonitor` (Singleton, `@Observable @MainActor`).

- **Signalquelle:** `PHAsset.location` der Fotos, die der ohnehin laufende
  Enumerations-Pass (`runFullSync`: Foreground-Resume, Kaltstart, BG-Task; plus
  reaktiv über `PHPhotoLibraryChangeObserver`) sowieso schon sieht — kein
  zusätzliches CoreLocation-Monitoring, keine neue Berechtigung. Betrachtet
  werden Fotos der letzten `lookback` = 48 h.
- **Heuristik (`TripAutoStartHeuristic`, pur/testbar, analog zu
  `TripAutoEndHeuristic`):** Fotos mit GPS **> 100 km** vom Home-Zentroid
  (`TripHomeLocation.resolve()`, dieselbe Quelle wie §9.1) UND über
  **≥ 2 distinkte Aufnahmezeitpunkte hinweg mit ≥ 6 h Spanne** zwischen erstem
  und letztem → Vorschlag. Die Zeitspanne verhindert, dass ein einzelnes Foto
  vom Flughafen-Zwischenstopp sofort auslöst; 100 km ist deutlich mehr als der
  2-km-Home-Radius aus §9.1 und mehr als ein typischer Tagesausflug.
  - Distanz und Spanne werden **nur über die weit entfernten Fotos** gemessen —
    sonst würde ein einzelnes fernes Foto die Zeitachse unbeteiligter
    Zuhause-Fotos erben.
  - Das jüngste ferne Foto muss höchstens `recencyWindow` = 12 h alt sein,
    sonst ist die Reise schon vorbei („heute früh heimgefahren").
  - Läuft bereits ein Trip (oder klingt einer gerade nach,
    `TripStore.hasPendingTripWork`), wird gar nicht erst geprüft — es gibt nur
    einen aktiven Trip (§14.4).
  - Kein Home-Zentroid bekannt → keine Prüfung, kein Vorschlag (wie überall in
    diesem Dokument: fehlende Geodaten sind kein Fehlerzustand, s. §14.3).
  - Nach einem abgelehnten Vorschlag greift `suggestionCooldown` = **24 h** —
    deutlich länger als die 6 h beim Ende, weil Starten die größere Zusage ist.
- **Signalisierung — bewusst leiser als beim Ende (§9.1), weil Starten mehr
  Konsequenzen hat als Beenden:**
  1. **Lokale Notification** „Sieht aus, als wärst du unterwegs" mit den
     Aktionen **„Trip starten"**, **„Nicht jetzt"** und **„Für diesen Ort nicht
     mehr fragen"** (letztere schreibt in `TripRegionSuppression`, §9.3).
  2. **„Trip starten" öffnet das vorbefüllte `TripStartSheet`** statt den Trip
     direkt zu starten — anders als beim Ende (§9.1: „Trip beenden" ist
     Ein-Klick). Der Start-Flow braucht den vom Nutzer bestätigten Namen
     (§14.3: Reverse-Geocoding → Vorschlag → Bestätigung/Editierbarkeit); das
     darf eine Notification-Aktion nicht überspringen. Technisch läuft das über
     `shouldPresentStartSheet`: die Aktion kann in einem frisch gestarteten
     Prozess laufen, lange bevor eine View existiert, die sie entgegennehmen
     könnte. `TripView` konsumiert das Flag beim Erscheinen. Der grobe Ort aus
     dem Foto-Cluster füllt den Namensvorschlag vorab, ersetzt aber nicht das
     übliche Reverse-Geocoding beim tatsächlichen Start.
  3. **Banner in `TripView`** im „Kein aktiver Trip"-Zustand (`noTripView`,
     `TripView.swift`) als Fallback, falls Notifications verweigert, verpasst
     oder ignoriert wurden — analog zum Auto-Ende-Banner in `ActiveTripView`.
     Im Vordergrund wird deshalb *keine* Notification gepostet: der Banner
     trägt sie bereits.
  4. **Tab-Icon-Badge:** der Punkt am Trip-Tab erscheint jetzt auch bei offenem
     Start-Vorschlag (`ContentView`), nicht nur bei laufendem Trip. Trägt
     allein, falls sowohl Notification als auch Banner verpasst wurden.
  Ein bloßes Antippen der Notification ohne Aktion öffnet nur die App (das
  vorbefüllte Sheet erscheint dann nicht automatisch) und ist kein implizites
  Ja — genau wie beim Ende (§9.1) räumt erst eine explizite Aktion den
  Vorschlag weg; „Nicht jetzt" startet zusätzlich den Cooldown.
- **Persistenz:** `PendingStartSuggestion` (Namensvorschlag, Gitterzelle,
  `travellingSince`, `raisedAt`) in `TripAutoStartPreferences` — getrennt von
  `TripAutoEndPreferences`, mit eigenen Keys: ein abgelehnter Start-Vorschlag
  für eine Region darf einen späteren Ende-Vorschlag nicht beeinflussen und
  umgekehrt. Der Monitor spiegelt den Zustand zusätzlich als `@Observable`
  in-memory, damit Banner und Badge darauf reagieren; UserDefaults ist die
  Kopie, die den Prozessneustart überlebt.

**Beide Notification-Kategorien werden gemeinsam registriert**
(`TripNotificationCategories.registerAll()`). `setNotificationCategories`
*ersetzt* die Menge, statt sie zu ergänzen — registrierte sich jede Kategorie
selbst, bliebe nur die zuletzt registrierte übrig und die andere Notification
käme ohne Aktions-Buttons an.

### 9.3 Vorschlag dauerhaft ortsbezogen abwählbar (umgesetzt)

Ohne das würde z. B. das tägliche Pendeln zum Arbeitsplatz jeden Tag „Trip Mode
einschalten?" fragen. Drei ineinandergreifende Bremsen:

1. **„Für diesen Ort nicht mehr fragen"** als Aktion am Vorschlag (Notification
   und Banner) → die Gitterzelle landet in `TripRegionSuppression`. Die
   Zellgröße ist `TripRegionGrid.cellDegrees` = 0,05° — derselbe Wert wie
   `HOME_CELL_DEG` in `photo/recaps.service.ts`, damit „dieser Ort" auf Client
   und Server dasselbe bedeutet. *Neue* Reiseziele werden weiterhin
   vorgeschlagen, nur dieser Ort verstummt.
2. **Auto-Unterdrückung häufiger Orte:** Zellen mit
   `autoSuppressAfterDistinctDays` = 5 distinkten Fototagen sind faktisch
   Zweit-Zuhause (Arbeit, Eltern, Gym) und nie Trips — dieselbe
   „distinkte-Tage"-Idee wie die Home-Erkennung, nur pro Region. Gezählt wird
   über **alle** Fotos des Passes, nicht nur die weit entfernten, und
   unabhängig davon, ob ein Vorschlag entsteht: eine Region qualifiziert sich
   gerade über die Besuche, die nie eine Nachfrage wert waren. Der Arbeitsweg
   verstummt so mit der Zeit von selbst.
3. **Cooldown & globaler Schalter:** 24 h Ruhe nach jedem Ablehnen (§9.2);
   zusätzlich in den Sync-Einstellungen der Schalter „Trip-Vorschläge", der
   beide Richtungen stilllegt — inklusive Zurücknahme einer bereits geplanten
   Ende-Benachrichtigung. Dort lassen sich auch die ausgeblendeten Orte wieder
   zurücksetzen.

**Warum die Regions-Unterdrückung nur den Start betrifft:** Die Region des
Ende-Vorschlags ist per Definition das Zuhause. „Hier nicht mehr fragen" wäre
dort kein Eingrenzen, sondern ein Abschalten des Features — und dafür ist der
globale Schalter da.

## 10. Server-Änderungen (minimal)

- `albums`: `is_trip boolean`, `trip_started_at timestamptz null`,
  `trip_ended_at timestamptz null` (Owner = `albums.user_id` existiert schon).
- `GET /trips/active` — Trips, die ich besitze oder in die ich geteilt bin und
  die aktiv sind (für den Beitritts-Dialog).
- Trip-Erstellung: `POST /albums` + Flag (oder dünnes `POST /trips`).
- Einladung: bestehendes `/albums/share` + neuer Notification-Typ „trip_invite".
- Alles andere (Album/Share/Sync-Endpunkte) unverändert wiederverwendet.

## 11. Client-State (`TripPreferences`)

`ActiveTrip`: `serverAlbumId`, `iosAlbumId`, `name`, `startedAt`, `endedAt?`,
`geofence?` (lat/lon/radius), `autoAdd` (auto/manuell), `mode` (sync/bisync),
`handledAssetIds` / `dismissedAssetIds`, `isShared`, `ownerUserId?`.

Für die Auto-Erkennung (Etappe 5): `suggestionsEnabled` (globaler Schalter),
`suppressedTripRegions` (Set von Gitterzellen-Keys), `lastSuggestionByRegion`
(Cooldown pro Region).

## 12. Etappen

1. **Solo, manuell gestartet** (Detailspezifikation §14): Trip-Tab (ersetzt
   Personen-Tab), Auto-iOS-Album + Server-Album (reuse `makeAvailable`),
   Capture-Window-Auto-Add (ChangeObserver + Catch-up beim Sync) inkl.
   `handledAssetIds`-Reconciliation, **Geofence + Auto-Name** aus CoreLocation.
   Modus sync. Genau **ein** aktiver Trip. Nur Bilder. Toggle-off friert ein.
2. **Manueller Kurationsmodus**: Review-Grid, Auswahl → hinzufügen → optional
   Sync, `dismissedAssetIds`.
3. **Geteilter Trip – Einladung**: `albums`-Trip-Spalten, Einladung via Share +
   Push, Empfänger-Provisionierung (direktes Mapping), Modus sync.
4. **Beitritt beim Einschalten**: `GET /trips/active` + Beitritts-Dialog.
5. **Auto-Vorschlag**: Home-Distanz-Erkennung + Auto-Ende.

## 13. Offene Detailfragen (für später)

- Auto-Ende-Heuristik: Schwellen (Stunden in Home-Region, km).
- „Trip aktiv" am Server: reicht `trip_ended_at IS NULL`, oder braucht es ein
  Sichtbarkeitsfenster für den Beitritts-Dialog (z. B. nur Trips der letzten
  N Tage)?

## 14. Etappe 1 – Detailspezifikation

Gesperrt am 2026-07-24.

### 14.1 Navigation / UI-Umbau

- **Tab-Leiste** (`ContentView.MainTabView`): Der **Personen-Tab wird durch
  einen Trip-Tab ersetzt**. Reihenfolge dann: Feed, Alben, **Trip**, Suche,
  Einstellungen.
- **Personen wandert in „Alben"** als spezielle Einstiegs-Zeile — analog zu den
  bestehenden „Alle Fotos" (`AllPhotosRef`) und „iOS Mediathek"
  (`LibraryBrowserRef`) oben in `AlbumsListView`. Neue Zeile „Personen" öffnet
  das bestehende Personen-Grid. (Eigener, klar abgrenzbarer Teil-Task des UI-
  Umbaus, unabhängig von der Trip-Logik.)
- **Trip-Tab-Icon ist zustandsabhängig**: unterschiedliches Symbol bzw.
  Einfärbung je nachdem, ob gerade ein Trip aktiv ist (z. B. akzentfarben/gefüllt
  bei aktivem Trip, neutral sonst).

### 14.2 Trip-View (Inhalt des Trip-Tabs)

- **Kein aktiver Trip:** Einstieg mit „Trip starten"-Aktion (+ ggf. Liste
  vergangener/eingefrorener Trips als normale Alben).
- **Aktiver Trip:** oben die Optionen-Buttons (Trip beenden, Modus
  copy/sync/bisync, Auto/Manuell, Name/Ort bearbeiten), darunter das **Foto-Grid**
  der Trip-Album-Inhalte. Im manuellen Modus zusätzlich der Button zum
  Review-Grid (Etappe 2).

### 14.3 Start-Flow

1. Toggle „Trip starten".
2. **CoreLocation** einmalig abfragen (Berechtigung „When in use" reicht):
   aktuelle Position → Reverse-Geocoding → **Ortsname sofort vorschlagen**, mit
   Bestätigung + Editiermöglichkeit. Der bestätigte Name wird Server-Album-Name.
3. **Home-Ausschlusszone** aus dem Home-Zentroid stempeln (nicht aus der
   Startkoordinate!). Der Startort dient ausschließlich dem Namensvorschlag.
   Die Zone wird **nachgereicht** (`TripStore.applyHomeExclusion`), nicht im
   Start-Pfad abgewartet: ein Trip startet oft ohne Netz. Bis sie steht, gilt
   das reine Zeitfenster — die sichere Richtung (lieber zu viel aufnehmen).
4. Auto-iOS-Album anlegen, `makeAvailable`-Logik (Server-Album per Namensabgleich
   finden/erstellen), Modus **sync**, confirm, `syncEnabled = true`,
   Watermark = jetzt.

### 14.4 Fixierte Parameter

- **Genau ein aktiver Trip** zur Zeit (keine parallelen Trips in Etappe 1).
- **Nur Bilder**, keine Videos (wie im bestehenden Upload).
- **`handledAssetIds` + High-Water-Mark auf `creationDate`** (umgesetzt): der
  Wasserstand (`ActiveTrip.handledWatermark`) ist die effiziente
  Enumerationsgrenze (wie beim Upload-Sync), die ID-Liste nur die kleine
  Randmenge — hält den State bei großen Bibliotheken/langen Trips klein.
  Details:
  - Der Wasserstand bedeutet „bis hierher wurde **alles angeschaut**" — auch
    Assets, die *keine* Kandidaten waren (bereits behandelt oder außerhalb des
    Geofence). Nur so darf die alte ID-Liste beim Vorrücken wegfallen: sonst
    könnte ein bereits behandeltes, neueres Foto unter den Wasserstand rutschen
    und beim nächsten Pass erneut eingefügt werden (Konflikt mit dem
    Aussortieren, §4).
  - Die Untergrenze ist **inklusiv** (`creationDate >= watermark`), die
    Randliste enthält genau die Assets auf diesem Zeitstempel. Ein striktes `>`
    würde Serienbilder verschlucken, die sich einen `creationDate` teilen.
    Rückt der Wasserstand vor, ersetzt die neue Randliste die alte; bleibt er
    gleich, werden beide vereinigt.
  - Der Wasserstand rückt **nur bei erfolgreichem Add** vor. Schlägt
    `performChanges` fehl, bleibt er stehen und die Assets werden beim nächsten
    Pass erneut versucht.
  - Trips, die vor dem Wasserstand gespeichert wurden, dekodieren ihn als `nil`
    und starten einmalig wieder bei `startedAt`; der erste Pass verdichtet die
    angesammelte ID-Liste. Keine Migration nötig.
  - Bekannte Konsequenz (wie beim Upload-Sync): ein Foto, das *nachträglich*
    mit einem `creationDate` unterhalb des Wasserstands in der Mediathek landet
    (iCloud-Nachlauf von einem anderen Gerät, Import), wird nicht mehr
    aufgenommen.
- **Home-Ausschluss-Mitgliedschaft**: Ein Fenster-Asset fällt nur dann raus,
  wenn es GPS hat *und* innerhalb der Home-Zone liegt. Alles andere im Fenster
  zählt zum Trip — unabhängig davon, wie weit es vom Startort entfernt
  aufgenommen wurde. Assets **ohne** GPS: „einschließen" (im Zweifel aufnehmen;
  Nutzer kann im manuellen Modus/beim Aussortieren korrigieren).

  > **Historie (Bug):** Bis dahin war dies eine *Einschluss*-Zone um den
  > Startort mit 25 km Radius. Ein Trip, der in München eingeschaltet und in
  > Frankfurt fotografiert wurde, verlor damit alle Fotos lautlos. Weil der
  > Wasserstand auch über die abgelehnten Assets vorrückt (siehe oben), war der
  > Verlust endgültig: die Fotos lagen unter dem Wasserstand und wurden nie
  > wieder enumeriert. Trips, die noch mit `geofence` gespeichert sind, setzen
  > beim Laden einmalig ihren Wasserstand zurück
  > (`TripPreferences.migratedFromStartGeofence`) und holen die Fotos nach.

### 14.5 ChangeObserver

- `PHPhotoLibraryChangeObserver` registrieren, während ein Trip aktiv ist; auf
  Bild-Assets beschränkt. Reaktives Auto-Add ergänzt den Catch-up-Pass in
  `runFullSync` (Foreground/Kaltstart/BG), ersetzt ihn nicht — der Catch-up
  bleibt die verlässliche Grenze gegen verpasste Änderungen bei App-Kills.
- Der Observer feuert **nur, während die App läuft**. Fotos, die in der
  Kamera-App bei suspendierter F4mil-App entstehen, erzeugen keinen Callback;
  der Catch-up in `runFullSync` ist für sie der einzige Weg.

### 14.6 Catch-up-Garantien

- Der Pass läuft in `runFullSync` **vor** Download/Upload und **außerhalb** des
  `pipelineLock`. Innerhalb des Locks wurde er übersprungen, sobald ein anderer
  Trigger schon eine Pipeline hielt (Kaltstart-Task und Foreground-Resume
  rennen routinemäßig gegeneinander) — die Fotos verpassten dann genau den
  Scan, der gerade lief. Der Pass ist lokal, billig und idempotent; der Lock
  schützt nur die Upload/Download-Pipeline.
- Gleichzeitige Trigger werden **verkettet, nicht verworfen**. Der frühere
  `isAutoAdding`-Guard gab bei laufendem Pass `0` zurück, wodurch ein während
  des Passes aufgenommenes Foto bis zum nächsten Trigger liegen blieb. Jetzt
  bekommt jeder Aufrufer einen Pass, der nach seinem Aufruf startet; ein
  Folge-Pass ohne neue Kandidaten kehrt sofort zurück, die Kette terminiert.
- Beendete Trips werden im selben Pass mitverarbeitet (Fenster bis `endedAt`),
  beendete zuerst. Beim Toggle-off läuft zusätzlich sofort ein Pass samt Sync,
  solange die App ohnehin im Vordergrund ist.

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
2. **Trip-Mitgliedschaft = Zeitfenster** als Default, **Geofence** als
   Verfeinerung.
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
- **Geofence (optional):** Startkoordinate + Radius; grenzt Mitgliedschaft ein
  (daheim während laufendem Trip gemachte Fotos fallen raus).
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
Vorschlag, nie automatisch (Zuverlässigkeit/Akku). Auto-Ende, wenn wieder
länger in Home-Region.

**Vorschlag dauerhaft ortsbezogen abwählbar (wichtig):** Ohne das würde z. B.
das tägliche Pendeln zum Arbeitsplatz jeden Tag „Trip Mode einschalten?" fragen.
Drei ineinandergreifende Bremsen:

1. **„Für diesen Ort nicht mehr fragen"** als Aktion am Vorschlag → die
   Gitterzelle (grob, ~5 km wie `HOME_CELL_DEG`) landet in
   `suppressedTripRegions`. *Neue* Reiseziele werden weiterhin vorgeschlagen,
   nur dieser Ort verstummt.
2. **Auto-Unterdrückung häufiger Orte:** Zellen mit vielen distinkten
   Fototagen/Besuchstagen sind faktisch Zweit-Zuhause (Arbeit, Eltern, Gym) und
   nie Trips — dieselbe „distinkte-Tage"-Idee wie die Home-Erkennung, nur
   multimodal. Der Arbeitsweg verstummt so mit der Zeit von selbst, auch ohne
   explizites Abwählen.
3. **Cooldown & globaler Schalter:** nach jedem Ablehnen für dieselbe Region
   eine Weile (Tage) nicht erneut fragen; zusätzlich in den Einstellungen ein
   grober Schalter „Trip-Vorschläge" ganz aus.

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
3. **Geofence** aus Startkoordinate + Default-Radius (Vorschlag 25 km) — schon
   in Etappe 1, weil CoreLocation für den Namen ohnehin gebraucht wird.
4. Auto-iOS-Album anlegen, `makeAvailable`-Logik (Server-Album per Namensabgleich
   finden/erstellen), Modus **sync**, confirm, `syncEnabled = true`,
   Watermark = jetzt.

### 14.4 Fixierte Parameter

- **Genau ein aktiver Trip** zur Zeit (keine parallelen Trips in Etappe 1).
- **Nur Bilder**, keine Videos (wie im bestehenden Upload).
- **`handledAssetIds` + High-Water-Mark auf `creationDate`**: der Wasserstand ist
  die effiziente Enumerationsgrenze (wie beim Upload-Sync), die ID-Liste nur die
  kleine „behandelt, aber wieder entfernt/verworfen"-Randmenge — hält den State
  bei großen Bibliotheken/langen Trips klein.
- **Geofence-Mitgliedschaft**: Ein Fenster-Asset zählt nur, wenn es GPS hat und
  im Radius liegt. Assets **ohne** GPS: Standard „einschließen" (im Zweifel
  aufnehmen; Nutzer kann im manuellen Modus/beim Aussortieren korrigieren) —
  Feinschliff später.

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

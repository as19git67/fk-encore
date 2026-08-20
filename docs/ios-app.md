# iOS-App (FKPhotos) – Feature-Inventar, Web-Vergleich & Parität-Plan

Stand: August 2026

Dieses Dokument beschreibt den tatsächlichen Funktionsumfang der nativen
iOS-App (`ios/`, SwiftUI), vergleicht den **Foto-Bereich** der Web-App mit der
iOS-App und leitet daraus einen priorisierten Plan ab, um – **dort wo es Sinn
ergibt** – Featuregleichheit herzustellen. Zusätzlich werden iOS-spezifische
Erweiterungen vorgeschlagen, die nur auf dem Gerät sinnvoll sind.

> **Wichtiger Hinweis zur Dokumentation:** Die `FEATURE_COMPARISON.md`
> beschrieb die iOS-App lange als „read-only, no auto-backup". Das ist
> **veraltet**. Die App besitzt inzwischen einen vollständigen Hintergrund-
> Backup-Stack, Zwei-Wege-Sync, eine Share-Extension, Passkeys sowie
> Kommentare/Reaktionen. Dieses Dokument holt die fehlende Dokumentation nach.

---

## 1. Architektur-Überblick

- **Sprache/UI:** Swift / SwiftUI, `@Observable`-ViewModels.
- **Einstieg:** `App/ContentView.swift` → `MainTabView` mit fünf Tabs:
  **Feed**, **Alben**, **Trip**, **Suche**, **Einstellungen**. Personen hängen
  an der Albenliste; **Rückblicke** und **Gruppen-Review** an der
  Feed-Toolbar.
- **Netzwerk:** `Core/Networking/APIClient.swift` (+ `AuthInterceptor`),
  spricht dieselbe Encore.ts-API wie das Web-Frontend.
- **Auth:** `Core/Auth/` – `AuthManager`, `KeychainHelper`, `PasskeyManager`.
- **Storage/Cache:** `Core/Storage/` – `ImageCache`, `ThumbnailLoader`,
  `SharedStorage` (geteilt mit der Share-Extension).
- **App-Targets:** Haupt-App, **Share-Extension** (`App/ShareExtension/`,
  `F4milShare/`) zum Hochladen aus anderen Apps.

---

## 2. Implementierte iOS-Features (Dokumentations-Nachzug)

Folgende Features sind im Code vorhanden, waren aber bisher **nicht
dokumentiert**:

### 2.1 Authentifizierung
- Passwort-Login (`AuthViewModel`, `LoginView`, `RegisterView`).
- **Passkeys / WebAuthn** (`PasskeyManager`, via `ASAuthorization`):
  Registrierung + Login gegen `/passkeys/register/*` und `/passkeys/auth/*`.
- Token-Persistenz in der Keychain (`KeychainHelper`).

### 2.2 Fotos & Galerie
- **„Alle Fotos"-Timeline** (`PhotoTimelineView` → `PhotoYearView` →
  `PhotoMonthGridView`) über `/photos/timeline`, als virtuelles Album oben in
  der Alben-Liste.
- **Vollbild-Viewer** (`PhotoFullscreenView`, ~740 Zeilen): native Pinch-Zoom
  (`ZoomableImageView`), Swipe-Navigation, Metadaten-Overlay.
- **Filter & Sortierung** (`FilterSortViewModel`, `FilterSortMenuView`):
  Favorit, GPS vorhanden, Datumsbereich; Sortierung nach Datum etc.
- **Metadaten-Ansicht** (`PhotoMetadataView`): Datei-Infos, Aufnahmedatum,
  Beschreibung, Qualitäts-Bewertung („x von 4"), erkannte Personen.
- **Per-Foto-Karte**: MapKit-Mini-Karte mit Marker bei vorhandenem GPS.
- **Auto-Crop-Fokuspunkt** wird beim Thumbnail berücksichtigt
  (`PhotoThumbnailView(autoCrop:)`).

### 2.3 Foto-Aktionen
- **Favorit** umschalten (Herz) im Vollbild.
- **Aufnahmedatum ändern**.
- **Zu Album hinzufügen** (`AddToAlbumManager`, Picker).
- **Teilen** über das native iOS-Share-Sheet (`PhotoShareManager`,
  `ActivityView`).
- **Personen benennen / zusammenführen** direkt aus erkannten Gesichtern
  im Vollbild.
- **Ausblenden / Einblenden**, **Aus dem Album entfernen** (im Album-Kontext),
  **Löschen** (nur mit `photos.delete`, mit Rückfrage) und **Original in die
  Fotos-Mediathek sichern** – alle im Überlauf-Menü des Vollbilds (Issue #762).

### 2.4 Alben
- Liste mit Suche, **Anpinnen** (`AlbumPinPreferences`), Wisch-Aktionen,
  Erstellen/Löschen.
- Detail-Ansicht mit Grid, Filter/Sort, **Mehrfachauswahl inkl.
  Drag-Select**, Stapel-Aktionen (zu Album hinzufügen, teilen), Upload.
- **Ansichtsmodi + Konsens** (`AlbumViewMode`, Issue #760): Umschalter für
  „Alle Fotos", „Meine Favoriten", „Gruppen-Highlights" (Konsens),
  „Von anderen favorisiert" und eine „Eigene Ansicht" mit einstellbaren
  Schwellenwerten. Die zählerbasierten Modi erscheinen nur bei geteilten Alben.
  Der gewählte Modus wird pro Album gemerkt.
- **Anonymisierte Abstimmung**: In geteilten Alben zeigt jedes Thumbnail
  „3/5"-Badges für Favoriten und Ausblendungen, das Vollbild einen
  „Meinungen"-Block mit Anteilsbalken. Die eigene Favoriten-Stimme lässt sich
  direkt aus dem Grid-Kontextmenü setzen; die Zähler aktualisieren sich sofort
  und werden bei einem Fehler zurückgerollt.

  Die Filterung passiert **auf dem Gerät**, nicht über das serverseitige
  `active_view`: Das Web setzt diese Einstellung bei jedem Album-Laden auf
  `"all"` zurück und filtert selbst clientseitig, ein von iOS gespeichertes
  Preset würde also stillschweigend verworfen. Details in
  `docs/album-photo-views.md`.
- **Album-Einstellungen** (`AlbumSettingsView`) wie im Web: Name,
  Beschreibung und „Karte aktivieren" (`display_mode`) ändern. Erreichbar über
  das Überlauf-Menü der Detailansicht und das Kontextmenü der Albenliste;
  Freigeben und Löschen sind aus demselben Sheet heraus möglich. Bearbeiten
  darf jeder mit Schreibzugriff, Löschen nur der Eigentümer.
- **Album teilen** wie im Web (`AlbumShareView`, `AlbumShareViewModel`,
  Issue #918): interne Nutzer mit „Nur lesen“, „Bearbeiten“ oder
  „Bearbeiten + Teilen“ einladen (letzteres nur als Eigentümer) sowie
  öffentlicher Link mit Ablaufdatum, Kopieren und Share-Sheet. Der geteilte
  Link zeigt auf die SPA-Route `/app/albums/shared/<token>`
  (`AlbumPublicLinkURL`) — dieselbe URL, die `web/static.ts` serverseitig als
  kanonische `pageUrl` baut und mit Open-Graph-Tags anreichert, damit
  iMessage-Vorschauen Albumnamen und Cover zeigen. Nicht zu verwechseln mit
  `/albums/public/<token>`, dem JSON-API-Endpunkt. Die
  einladbaren Nutzer kommen aus `/albums/:id/shareable-users`, sodass auch
  Nicht-Admins und `write_share`-Delegierte teilen können; Delegierte können
  nur ihre eigenen Einladungen wieder entfernen. Erreichbar aus der
  Album-Detailansicht und direkt aus dem laufenden Trip.

### 2.5 Personen & Gesichter
- Personen-Grid (`PersonsListView`), Umbenennen, Zusammenführen,
  Gesichter ignorieren („Alle ignorieren").
- **Jahres-Kacheln** in der Personen-Detailansicht (neu, Issue #391): Fotos
  einer Person werden nach Jahr gruppiert; bei vielen Fotos wird initial nur
  das neueste Jahr gerendert.

### 2.6 Suche
- Volltext-/Natürliche-Sprache-Suche (`SearchView`, `SearchViewModel`) über
  denselben Backend-Endpunkt wie das Web (semantisch, Ort, POI, Radius via
  Query-Parsing). UI aktuell: einzelnes Suchfeld + Vorschläge.

### 2.7 Feed (Aktivität, Kommentare, Reaktionen)
- **Feed-Tab** mit Ungelesen-Badge (`FeedViewModel.unreadCount`).
- **Reaktionen / Likes** und **Ausblenden** je Foto.
- **Kommentare ansehen und schreiben** (`FeedCommentSection`).

### 2.8 Backup & Sync (Kern-Stärke der iOS-App)
- **Automatischer Upload** (`PhotoSyncService`, `AssetUploadEnqueuer`,
  `UploadQueue`): Modi „Alle Fotos hochladen" / „Nur neue Fotos" /
  „Nur neue ab jetzt".
- **Hintergrund-Sync** (`BackgroundSyncManager`): nutzt unter iOS 26.1+ die
  `PHBackgroundResourceUploadExtension`, darunter `BGProcessingTask` als
  Fallback.
- **Nur-WLAN**-Beschränkung (`wifiOnly`, Standard an) für Up- und Download.
- **Geräte-Album → Server-Album-Zuordnung** (`ServerAlbumPickerView`,
  „Album-Zuordnungen").
- **Medientypen-Auswahl** und **Screenshots ausschließen**.
- **Zwei-Wege-Sync**: automatischer **Download** auf das Gerät
  (`PhotoDownloadService`, `DownloadSyncPreferences`, `DownloadSettingsView`).
- **Foto-Hashing** (`PhotoHashing`) zur Duplikat-/Wiedererkennung.
- **Share-Extension**: Fotos aus anderen Apps direkt hochladen.

### 2.9 Rückblicke & Gruppen-Review
- **Rückblicke** (`RecapsListView`, `RecapPlayerView`, Issue #759): story-artiger
  Vollbild-Player mit Auto-Advance, Segment-Fortschrittsbalken, Tippen zum
  Blättern, Halten zum Pausieren und Runterwischen zum Schließen. Dazu
  Trip-Karten-Intro, „Damals & heute"-Vergleich und optionale Hintergrundmusik.
  Einstieg über den Streifen im Feed und die Feed-Toolbar. Read-only – Recaps
  entstehen serverseitig.
- **Gruppen-Review** (`ReviewQueueView`, Issue #761): Wisch-basierte Prüfung
  ähnlicher Fotos gegen `/photos/groups/review-queue`. Rechts = KI-Vorschlag
  übernehmen, links = alle behalten, hoch = favorisieren **und** übernehmen;
  bei Peer-Signal zusätzlich „Konsens übernehmen". Tippen auf ein Foto öffnet
  die zoombare Großansicht (`ReviewPhotoPreview`) und entscheidet nichts – „Nur
  dieses Foto behalten" ist dort ein beschrifteter Button, ebenso im
  Kontextmenü der Kachel. Wer den KI-Vorschlag überstimmen will, öffnet
  „Auswahl anpassen …" (`ReviewSelectionSheet`): jedes Foto mit Daumen
  hoch/runter, vorbelegt aus dem Vorschlag, lokal bis zum Commit – das
  Gegenstück zur Bestätigungsphase des Web-Vergleichs. Die Großansicht zeigt
  dieselben Daumen, sodass die Entscheidung direkt am großen Bild geändert
  werden kann. Jede Geste hat einen gleichwertigen Button
  (VoiceOver). Fortschrittsbalken, Filter nach Sicherheitsstufe und ein
  garantiert einstufiges **Rückgängig** – die neueste Entscheidung wird lokal
  gepuffert und erst mit der nächsten (oder beim Verlassen) gesendet, weil das
  Backend kein „Un-Review" kennt. Entscheiden erfordert `photos.delete`.

### 2.10 Einstellungen / Admin
- Profil-Anzeige (Name, E-Mail, Rollen).
- **Benutzerverwaltung** (`UsersListView`) und **Rollen & Berechtigungen**
  (`RolesView`) – Basis-Admin.
- Sync-Einstellungen (Upload/Download), Server-Verbindung, Abmelden.

---

## 3. Vergleich: Web-Foto-Bereich ↔ iOS

Legende: ✅ vorhanden · ⚡ vorhanden & überlegen · 🔶 teilweise/anders · ❌ fehlt

### 3.1 Ansicht & Navigation
| Feature | Web | iOS |
|---|---|---|
| Chronologische Timeline / „Alle Fotos" | ✅ Virtual-Scroll | ✅ Jahr → Monat |
| Filter (Favorit, GPS, Datum, Medientyp) | ✅ | ✅ (Favorit, GPS, Datum) |
| Sortierung (Datum/Qualität/Name/Größe) | ✅ | 🔶 (Teilmenge) |
| Vollbild + Zoom | ✅ | ✅ native Pinch-Zoom |
| Diashow / Slideshow | ✅ | ❌ |
| Mehrfachauswahl + Stapelaktionen | ✅ (Galerie + Album) | 🔶 (Album/Monat, nicht in „Alle Fotos") |
| Fotos vergleichen | ✅ `PhotoCompareView` | ❌ |

### 3.2 Foto-Aktionen
| Feature | Web | iOS |
|---|---|---|
| Favorit | ✅ | ✅ |
| Ausblenden / Einblenden | ✅ | ✅ (Feed + Vollbild) |
| Löschen | ✅ | ✅ (mit `photos.delete`) |
| Original herunterladen | ✅ | ✅ (in die Fotos-Mediathek) |
| Teilen (nativ) | 🔶 (Link) | ⚡ iOS-Share-Sheet |
| Zu Album hinzufügen | ✅ | ✅ |
| Aus Album entfernen | ✅ | ✅ (im Album-Kontext) |
| Aufnahmedatum ändern | ✅ | ✅ |
| GPS-Ort setzen/ändern | ✅ `PhotoLocationMenu` | ❌ (nur Anzeige) |
| Reindex / Metadaten aktualisieren | ✅ | ❌ |
| Nicht-destruktive Transformationen (Crop/Rotate) | ✅ `PhotoTransformEditor` | ❌ |
| Collage erstellen | ✅ `CollageDialog` | ❌ |

### 3.3 Metadaten
| Feature | Web | iOS |
|---|---|---|
| EXIF-/Metadaten-Sidebar | ✅ | ✅ |
| Qualitäts-Score-Anzeige | ✅ | ✅ |
| Per-Foto-Karte | ✅ | ✅ |
| Erkannte Gesichter + Benennen | ✅ | ✅ |

### 3.4 Alben
| Feature | Web | iOS |
|---|---|---|
| Liste / Erstellen / Löschen | ✅ | ✅ |
| Album anpinnen | 🔶 | ⚡ (Pin + Wisch-Aktionen) |
| Ansichtsmodi (Alle/Favoriten/Konsens/Eigen) | ✅ | ✅ `AlbumViewMode` |
| Konsens-/anonyme Abstimmung | ⚡ | ✅ (Badges „3/5" + Favoriten-Vote) |
| Mit Nutzern teilen (Rollen) | ✅ | ✅ |
| Öffentliche Links (mit Ablauf) | ✅ | ✅ |
| Cover setzen / Album bearbeiten | ✅ | ❌ |
| In Album hochladen | ✅ | ✅ |

### 3.5 Personen & Gesichter
| Feature | Web | iOS |
|---|---|---|
| Personen-Grid, Umbenennen, Merge, Ignorieren | ✅ | ✅ |
| Jahres-Kacheln pro Person | ❌ | ⚡ (neu) |
| Geburtstag / Alter zum Aufnahmezeitpunkt | ❌ | ❌ |

### 3.6 Suche
| Feature | Web | iOS |
|---|---|---|
| Semantisch / natürliche Sprache | ✅ | ✅ |
| Ort / POI / Radius | ✅ | ✅ (gleiches Backend) |
| Filter-Chips / strukturierte Filter-UI | ✅ `NaturalSearchBar` + Chips | 🔶 (einzelnes Feld) |

### 3.7 Feed / Soziales
| Feature | Web | iOS |
|---|---|---|
| Aktivitäts-Feed (Album-Aktivität) | ✅ | ✅ (Badge) |
| Foto-Stream (chronologisch) | ✅ `PhotoFeedView` | 🔶 (Feed = Aktivität) |
| Reaktionen / Likes | ✅ | ✅ |
| Kommentare (lesen + schreiben) | ✅ | ✅ |
| Push-Benachrichtigungen | ✅ (PWA-Push) | ❌ |

### 3.8 Rückblicke & Review
| Feature | Web | iOS |
|---|---|---|
| Rückblicke (Recaps) – Player | ✅ `RecapsView`/`RecapPlayer` | ✅ `RecapPlayerView` |
| „An diesem Tag" / Memories | 🔶 (über Recaps) | 🔶 (über Recaps) |
| Gruppen-Review (Review-Queue) | ✅ `ReviewQueueView` | ✅ `ReviewQueueView` (Swipe) |

### 3.9 Backup & Sync
| Feature | Web | iOS |
|---|---|---|
| Manueller Upload | ✅ | ✅ |
| Auto-Backup im Hintergrund | ❌ | ⚡ |
| Nur-WLAN | ❌ | ✅ |
| Geräte-Album → Server-Album-Mapping | ❌ | ✅ |
| Screenshots ausschließen / Medientypen | ❌ | ✅ |
| Zwei-Wege-Sync (Download aufs Gerät) | ❌ | ✅ |
| Upload-Queue + Retry | ❌ | ✅ |
| Share-Extension (Upload aus anderen Apps) | ❌ | ✅ |

### 3.10 Auth & Admin
| Feature | Web | iOS |
|---|---|---|
| Passwort + Passkeys | ✅ | ✅ |
| Benutzer-/Rollenverwaltung | ✅ (vollständig) | 🔶 (Basis) |
| Datenverwaltung / Jobs / Purge | ✅ | ❌ (bewusst Web) |

---

## 4. Plan: Featuregleichheit (nur wo sinnvoll)

Priorisiert nach Nutzen ÷ Aufwand und „passt das auf ein Telefon?".

### Etappe 1 – Hoher Nutzen, mobil naheliegend *(umgesetzt)*

Alle vier Punkte sind in der App vorhanden; die Beschreibungen bleiben als
Referenz stehen, was jeweils gebaut wurde.

1. ✅ **Rückblicke/Recaps-Viewer** – Story-artige Wiedergabe ist auf dem Handy
   ideal. Read-only-Konsum der bestehenden `/recaps`-Daten + `RecapPlayer`-
   Pendant in SwiftUI (`TabView`-Paging, Auto-Advance, Musik optional).
2. ✅ **Album-Ansichtsmodi + Konsens/Abstimmung** – das Alleinstellungsmerkmal
   der App (kollaborative Kuratierung). Modi „Alle / Favoriten / Konsens",
   Favoriten-Toggle je Album-Mitglied, „3/5 Favoriten"-Anzeige.
3. ✅ **Gruppen-Review (Review-Queue)** – Swipe-basiertes Review (links/rechts)
   passt hervorragend zu Touch.
4. ✅ **Foto-Aktionen im Vollbild vervollständigen** – Ausblenden/Einblenden,
   Aus Album entfernen, Löschen (mit Berechtigung), Original herunterladen.
   Schließt alltägliche Lücken; nutzt vorhandene Endpunkte.

### Etappe 2 – Mittlerer Nutzen
5. **GPS-Ort setzen/ändern + interaktive Karten-/Trip-Ansicht** – Karte mit
   Foto-Clustern; Ort per Karten-Pin oder Suche zuweisen.
6. ✅ **Öffentliche Album-Links** erstellen und per Share-Sheet teilen
   (Ablaufdatum) – umgesetzt in `AlbumShareView`; der geteilte Link zeigt auf
   die SPA-Route `/app/albums/shared/<token>` (`AlbumPublicLinkURL`).
7. **Mehrfachauswahl in „Alle Fotos"** inkl. Stapelaktionen.
8. **Reichere Such-Filter (Chips)** – strukturierte Filter analog
   `NaturalSearchBar`.
9. **Diashow** im Vollbild.

### Etappe 3 – Nice-to-have / aufwändiger
10. **Nicht-destruktiver Transform-/Crop-Editor** – komplex; ggf. später.
11. **Collage-Erstellung**.
12. **Fotos vergleichen**.

### Bewusst **nicht** portieren (Web sinnvoller)
- Vollständige Datenverwaltung, geplante Jobs, Purge → bleibt Web-/Admin-Domäne.
- Gast-/Public-Link-Empfänger-Flows (Gast-Dialoge) → Web-Konzept.
- CLI-/Bulk-Upload.

---

## 5. iOS-spezifische Erweiterungen (nur auf iOS sinnvoll)

Diese Features ergeben primär oder ausschließlich auf dem Gerät Sinn und wären
eine echte Bereicherung:

1. **„Speicher freigeben"** – bereits gesicherte Original-Fotos vom Gerät
   entfernen (Immich-Stil), inkl. „nur bestätigt hochgeladene".
2. **Home-Screen-Widgets** – „An diesem Tag" / letzter Rückblick / neueste
   Feed-Aktivität (WidgetKit).
3. **Live Activity / Dynamic Island** für Backup-Fortschritt.
4. **App Intents / Siri-Shortcuts** – „Jetzt sichern", „Suche nach …",
   „Zeige Rückblick".
5. **Lokale Benachrichtigungen** – Backup abgeschlossen, neue Kommentare/Likes
   (bis Remote-Push via APNs steht).
6. **Remote-Push (APNs)** – Gegenstück zum bestehenden `push`-Service & PWA-Push
   (zählt auch zur Parität, ist aber iOS-Plattformarbeit).
7. **Spotlight-Indexierung** von Personen/Alben für die System-Suche.
8. **Live Photos** – Erfassung/Upload von Bewegungsanteil (sobald das Backend
   Video/Motion unterstützt; aktuell rein fotobasiert).
9. **Limited-Library-Picker-Politur** (PhotoKit) und Focus-Filter.
10. **Handoff & Deep Links** zwischen iOS und Web.

---

## 6. Offene Dokumentations-Punkte

- `FEATURE_COMPARISON.md` Abschnitt 8 („Mobile Apps") und die Zusammenfassung
  wurden mit diesem Stand aktualisiert (iOS ist nicht mehr „read-only").
- Die Sync-Architektur (Upload-Queue, Hintergrund-Task, Hash-Abgleich,
  Zwei-Wege-Sync) ist in [`ios-backup-sync.md`](./ios-backup-sync.md)
  dokumentiert.
- Die Album-Ansichtsmodi inklusive der Begründung, warum iOS auf dem Gerät
  filtert statt `active_view` zu speichern, stehen in
  [`album-photo-views.md`](./album-photo-views.md).
- Die Wisch-Variante der Review-Queue samt Gesten-Tabelle und dem Verhalten
  des einstufigen Undo steht in [`ai-auto-pick.md`](./ai-auto-pick.md).

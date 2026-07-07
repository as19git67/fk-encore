# iOS Backup & Sync – Architektur

Stand: Juni 2026

Dieses Dokument beschreibt die **Backup-/Sync-Architektur** der nativen
iOS-App (`ios/`): wie Fotos vom Gerät zum Server hochgeladen (Upload-Sync) und
wieder auf das Gerät geladen werden (Download-Sync), wie der Vorgang im
Hintergrund läuft und wie Duplikate vermieden werden. Ergänzt das
Feature-Inventar in [`ios-app.md`](./ios-app.md) um die technischen Details.

---

## 1. Komponenten

| Datei | Rolle |
|---|---|
| `Features/Sync/PhotoSyncService.swift` | Orchestriert einen Upload-Sync-Lauf (`actor`). |
| `Features/Sync/AssetUploadEnqueuer.swift` | Wandelt ein `PHAsset` in einen `UploadQueueItem` (gemeinsam für manuellen & automatischen Upload). |
| `Features/Sync/UploadQueue.swift` | Persistente Upload-Warteschlange im App-Group-Container (`actor`). |
| `Features/Sync/PhotoHashing.swift` | Berechnet `imageDataHash` / `fullHash` (`PhotoHasher`). |
| `Features/Sync/BackgroundSyncManager.swift` | Hintergrund-Ausführung (BGTask / PhotoKit), Queue-Drain, Netzwerk-Gate. |
| `Features/Sync/PhotoDownloadService.swift` | Zwei-Wege-Sync: lädt Server-Fotos aufs Gerät (`actor`). |
| `Features/Sync/PhotoSyncPreferences.swift` | UserDefaults-Keys & typisierte Accessoren für den Upload. |
| `Features/Sync/DownloadSyncPreferences.swift` | dito für den Download. |
| `Features/Sync/SyncProgress.swift` | Beobachtbarer Fortschritt für die UI. |
| `Features/Sync/SyncSettingsView.swift` / `DownloadSettingsView.swift` | Einstellungen. |
| `Features/Sync/ServerAlbumPickerView.swift` | Geräte-Album → Server-Album-Zuordnung. |
| `Core/Storage/SharedStorage.swift` | App-Group-UserDefaults (Token-/Server-URL-Sharing mit der Share-Extension). |
| `App/ShareExtension/`, `F4milShare/` | Share-Extension zum Upload aus anderen Apps. |

App-Group: **`group.dev.fk-encore.F4milPhotos`** (gemeinsamer Container für
Queue-Datei, Temp-Dateien und geteilte UserDefaults).

---

## 2. Hashing- & Dedup-Modell

`PhotoHasher` erzeugt pro Asset einen `PhotoHashResult` mit drei Werten:

- **`imageDataHash`** – SHA-256 der **dekodierten Bildpixel**. Stabil über
  Caption-/Favorit-/Datums-Änderungen hinweg → identifiziert „dasselbe Bild".
- **`fullHash`** – SHA-256 über `imageDataHash + caption + isFavorite +
  capturedAtString`. Ändert sich bei **jeder sync-relevanten** Änderung →
  identifiziert „dieses Bild in genau diesem Zustand".
- **`capturedAtString`** – Aufnahmezeit in `TimeZone.current` (v2-Cache;
  behebt UTC-Drift bei heruntergeladenen Fotos).

Wichtig: Gehasht und hochgeladen werden die Bytes der **besten Ressource**
(`AssetUploadEnqueuer.bestResource`) – bevorzugt der **bearbeitete** Render
(`.fullSizePhoto`), sonst das Original (`.photo`). Hash-Pipeline, hochgeladene
Bytes (`PhotoSyncService.loadAssetData`) und Hintergrund-Jobs verwenden
zwingend dieselbe Ressourcen-Auswahl, damit der serverseitige Dedup über beide
Upload-Pfade identisch greift (#591). Der Dateiname wird dagegen aus der
`.photo`-Ressource gelesen (der `.fullSizePhoto`-Render heißt generisch
`FullSizeRender.heic`).

`PhotoHasher` cached Ergebnisse per `localIdentifier` und überspringt
Neu-Hashing, solange die `modificationDate` des Assets unverändert ist
(`PhotoSyncPreferences.HashCacheEntry`).

---

## 3. Upload-Sync-Pipeline (`PhotoSyncService.sync()`)

Vorbedingungen (sonst stiller Abbruch): `syncEnabled`, Netzwerk-Gate erfüllt
(siehe §6), Foto-Berechtigung `.authorized`/`.limited`.

1. **Queue zuerst leeren** (`drainQueueWithProgress`) – Share-Extension-Items
   und Reste eines abgebrochenen Laufs werden sofort hochgeladen, damit der
   Nutzer Fortschritt sieht, statt auf den Library-Scan zu warten.
2. **Assets ermitteln** (`fetchAssets`, off-main): je nach Auswahl die ganze
   Mediathek (Sentinel `__all_photos__`) oder die **bestätigten** Album-IDs;
   gefiltert über `PHFetchOptions` (nur Bilder, `creationDate`/`modificationDate`
   neuer als das Album-Watermark, optional Screenshots ausgeschlossen).
3. In **Batches à 500**:
   - **Hashen** (`PhotoHasher`, mit Cache).
   - **Sync-Check**: `APIClient.syncCheck` (`POST /photos/sync/check`) liefert,
     welche `fullHash`-Werte der Server schon hat.
   - **Enqueue** der fehlenden Assets (und noch nicht in der Queue liegenden)
     als `UploadQueueItem` via `AssetUploadEnqueuer.makeQueueItem`, danach
     erneuter Queue-Drain.
   - **Watermark** je Quell-Album monoton auf die neueste `creationDate` der
     erfolgreich verarbeiteten Assets vorrücken (`advanceAlbumSyncDate` schreibt
     nur, wenn strikt neuer → keine Rückwärts-Sprünge bei out-of-order-Abschluss).
     Assets, deren Hash fehlschlug (z. B. iCloud-Bytes nicht verfügbar), werden
     **bewusst nicht** ins Watermark aufgenommen und beim nächsten Lauf erneut
     versucht.
4. **Abschluss**: finaler Drain + `lastSyncDate` setzen.

Bei jedem Exit-Pfad (auch Task-Abbruch durch BGTask-Zeitlimit) wird der
Fortschritt zurückgesetzt, damit der Spinner nie hängen bleibt.

### Manueller Upload

`PhotoUploadView` nutzt denselben `AssetUploadEnqueuer`, sodass manuell und
automatisch hochgeladene Fotos serverseitig identisch dedupliziert werden.

---

## 4. Upload-Queue (`UploadQueue`)

- **Persistenz**: JSON-Datei `upload_queue.json` im App-Group-Container →
  überlebt App-Neustarts und ist von Haupt-App **und** Share-Extension lesbar.
  Temp-Bilddaten liegen in `pending_uploads/`.
- **Status** je Item: `pending → uploading → done | failed`.
- **Nebenläufigkeit**: `claimNextPending()` schaltet **atomar** ein Item von
  `pending` auf `uploading`. Ab da ist es für andere Drain-Läufe (anderer
  Prozess: Haupt-App vs. Share-Extension) unsichtbar – verhindert die
  Doppel-Uploads, die früher Server-Duplikate erzeugten.
- **Wiederaufnahme**: durch Hintergrund-Suspendierung abgebrochene Uploads
  landen als `failed` mit transienter Fehlermeldung; `requeueTransientFailures()`
  (beim Foreground-Resume) setzt diese auf `pending` zurück. `resetStaleUploading()`
  beim App-Start räumt nach einem Crash hängengebliebene `uploading`-Items auf.
- **UI**: `UploadQueueObserver` (`@Observable @MainActor`) spiegelt die Queue
  über einen `AsyncStream` live in SwiftUI.

---

## 5. `UploadQueueItem` & Server-Contract

Ein `UploadQueueItem` trägt u. a. `imageDataHash`, `fullHash`,
`capturedAtString`, `caption`, `isFavorite`, `targetAlbumIds`,
`sourceIosAlbumId`, optionale GPS-Koordinaten und (für Share-Extension-Items)
eine `tempFileURL`.

Upload-Request an **`POST /photos`** (`photo/photo.ts`) trägt die Metadaten als
Header:

| Header | Inhalt |
|---|---|
| `X-File-Name` | Originaldateiname (percent-encoded) |
| `X-Image-Data-Hash` | Pixel-Hash → serverseitiger Dedup |
| `X-Full-Hash` | Zustands-Hash |
| `X-Description` | Caption (percent-encoded) |
| `X-Is-Favorite` | `true`/`false` |
| `X-Captured-At` | Aufnahmezeit |
| `X-Asset-Id` | `PHAsset.localIdentifier` → Dedup/Replace per `device_asset_id` |
| `X-GPS-Lat` / `X-GPS-Lon` | GPS-Fallback (die Resource-Bytes sind EXIF-bereinigt) |

Weitere Endpunkte:
- **`POST /photos/sync/check`** – Batch-Abgleich: welche `fullHash` existieren schon.
- **`POST /photos/sync/metadata`** – reiner Metadaten-Sync (Pixel unverändert,
  nur Caption/Favorit/Datum geändert); `.notFound` ⇒ Fallback auf vollen Upload.
- **`GET /photos/index`** (ETag) – Fast-Skip für den Download (§7).

---

## 6. Netzwerk-Gate („Nur WLAN")

`BackgroundSyncManager.networkAllowsUpload()` ist die **einzige** Quelle der
Wahrheit für das Gate und wird sowohl vor als auch **während** des Queue-Drains
(vor jedem Item) frisch ausgewertet:

- `PhotoSyncPreferences.wifiOnly` (Default **an**) direkt aus UserDefaults.
- Live-Pfad von `PhotoSyncService` (`isWifiConnected` / `isNetworkAvailable`).

So wirkt ein Umschalten der Einstellung oder ein Konnektivitätswechsel sofort,
auch mitten im Drain (ein bei wieder eingeschaltetem „Nur WLAN" laufendes Item
wird als `pending` zurückgelegt).

> **First-Path-Race (behoben):** `NWPathMonitor.currentPath` ist im kurzen
> Fenster direkt nach `start()` noch nicht zuverlässig befüllt. Früher meldete
> der **erste** Tap auf „Jetzt synchronisieren" deshalb fälschlich „kein WLAN"
> und man musste zweimal tippen. `PhotoSyncService`/`PhotoDownloadService`
> cachen den Pfad jetzt über den `pathUpdateHandler` und **warten beim ersten
> Aufruf auf das erste Update** (mit Sicherheits-Timeout), bevor sie antworten.

---

## 7. Hintergrund-Ausführung

Zwei Pfade, abhängig von der iOS-Version:

- **iOS 26.1+**: PhotoKit-Hintergrund-Upload
  (`PHBackgroundResourceUploadExtension`). `enqueueForBackgroundUpload` bäckt den
  `POST /photos`-Request inkl. frisch erneuertem Token
  (`APIClient.ensureFreshToken()`) und übergibt ihn dem System. Hinweis: Da es
  (noch) kein dediziertes Extension-Target gibt, kann der System-Job das Token
  nicht selbst erneuern – läuft er nach Ablauf, scheitert er still und der
  Foreground-Drain lädt später erneut hoch.
- **iOS < 26.1 / Fallback**: `BGProcessingTask`
  (`dev.fk-encore.F4milPhotos.photoSync`). `register()` wird im `AppDelegate`
  vor App-Ende registriert; `scheduleNextSyncIfNeeded()` plant beim Wechsel in
  den Hintergrund den nächsten Lauf (`requiresNetworkConnectivity = true`,
  `earliestBeginDate` +5 min) und storniert ihn, wenn weder Up- noch Download
  aktiv ist. Der Handler ruft `drainUploadQueue()`/`PhotoSyncService.sync()`.

`drainUploadQueue()` ist durch `drainLock` gegen einen zweiten gleichzeitigen
Drain im selben Prozess geschützt; prozessübergreifend schützt zusätzlich der
atomare `claimNextPending()`-Schritt.

Beim Foreground-Resume (`applicationWillEnterForeground`) ruft
`handleForegroundResume()` → `requeueTransientFailures()` + Drain, damit
abgebrochene Uploads nicht als „Geister-Fehler" stehenbleiben.

---

## 8. Album-Zuordnung & Auswahl

- **Geräte-Album → Server-Album**: `PhotoSyncPreferences.albumMappings`
  (`[iOS-localIdentifier: serverAlbumId]`), gepflegt über `ServerAlbumPickerView`.
- **Bestätigte Zuordnungen**: `confirmedMappingIds` – nur Alben mit einer
  expliziten Nutzer-Entscheidung (inkl. „kein Album") werden auto-synchronisiert;
  unbestätigte werden übersprungen.
- **„Gesamte Mediathek"**: Sentinel `__all_photos__` – enumeriert alle
  Bild-Assets direkt; bei gesetztem Sentinel werden Einzelalben ignoriert
  (kein versehentlicher Doppel-Sync).
- **Screenshots ausschließen**: `excludeScreenshots` (Default **an**).
- **Server-Foto-Map**: `serverPhotoMap` (`[serverPhotoId: iOS-localIdentifier]`)
  wird beim Upload gepflegt und vom Download genutzt, um bereits lokal
  vorhandene Fotos nicht erneut herunterzuladen. Bleibt bei
  `resetUploadHistory()` erhalten (strukturelles Wissen).
- **Sync-Modus je Album** (`albumSyncModes`, Issue #812): `copy` oder `sync`,
  gewählt beim „Verfügbar machen" in der iOS-Mediathek. Default `copy`
  (Etappe-2-Verhalten). Bei `sync` läuft vor dem Upload-Scan der
  Löschabgleich `PhotoSyncService.syncAlbumDeletions()`:
  aktuelle iOS-Album-Mitgliedschaft (nur `localIdentifier`) vs.
  `GET /albums/:id/photos`; Server-Fotos, die über `serverPhotoMap` von
  diesem Gerät stammen und deren Quell-Asset das iOS-Album verlassen hat,
  werden via `POST /albums/photos/batch` (`action: "remove"`) aus dem
  Album entfernt. **Nicht-destruktiv**: nur die Album-Zuordnung wird
  gelöst, das Foto bleibt auf dem Server; Web-Uploads (nicht in
  `serverPhotoMap`) werden nie angefasst; ein nicht auflösbares Album wird
  übersprungen (kein versehentliches Leeren).

---

## 9. Download-Sync (Zwei-Wege)

`PhotoDownloadService.sync()` lädt ausgewählte Server-Alben aufs Gerät:

- Vorbedingungen: `downloadEnabled`, Netzwerk-Gate (eigener
  `wifiOnly`-Schalter), `selectedServerAlbumIds` nicht leer, Foto-Berechtigung
  `readWrite` (`.authorized`/`.limited`).
- **Fast-Skip per ETag**: `GET /photos/index` mit `If-None-Match`. Ein **304**
  bedeutet „nichts geändert" und überspringt den Album-Walk. Der erste Lauf
  (ohne ETag) macht den vollen Walk und speichert das ETag.
- Eigener `F4mil Trash`-Mechanismus zum Verschieben gelöschter Fotos (nur bei
  `readWrite`-Zugriff).
- Eigener `NWPathMonitor` mit derselben First-Path-Await-Logik wie der Upload.

Einstellungen in `DownloadSyncPreferences` (`download.enabled`,
`download.wifiOnly`, ausgewählte Server-Alben, `lastIndexETag` …).

---

## 10. Share-Extension & Token-Sharing

- Die Share-Extension legt hochzuladende Fotos als `UploadQueueItem`
  (mit `tempFileURL`) in dieselbe `UploadQueue` → die Haupt-App lädt sie beim
  nächsten Drain hoch.
- **`SharedStorage`** (App-Group-UserDefaults) spiegelt Access-/Refresh-Token,
  Token-Ablauf (`tokenExpiryKey`, Epoch-Sekunden) und Server-URL, damit die
  Extension API-Calls ohne Zugriff auf die Keychain der Haupt-App machen und das
  Token selbst erneuern kann. `AuthManager.saveTokens`/`restoreSession` halten
  diese Spiegelung aktuell.
- Der `ShareHasher.imageDataHash` der Extension muss **byte-identisch** zum
  `PhotoHasher.imageDataHash` der Haupt-App bleiben, damit der Dedup greift.

---

## 11. Fehlerbehandlung & Wiederholung

- Transiente `URLError`/Cancellation-Fehler werden gemustert
  (`isTransientErrorMessage`) und automatisch erneut in die Queue gelegt.
- Items, deren Asset-Bytes nicht hashbar sind (iCloud nicht verfügbar), werden
  übersprungen und beim nächsten Lauf erneut versucht (kein Watermark-Vorlauf).
- `retryCount`/`lastError` je Item; die UI bietet „Alle erneut" / „Alle löschen".

---

## 12. Bekannte Grenzen / offen

- Kein dediziertes `PHBackgroundResourceUploadExtension`-Target → System-Upload
  kann das Access-Token nicht selbst erneuern (siehe §7).
- Kein „Speicher freigeben" (bereits gesicherte Originale vom Gerät entfernen) –
  geplant, siehe [`ios-app.md`](./ios-app.md) §5 / Issue-Tracker.
- Rein fotobasiert; Live Photos / Video werden (noch) nicht gesichert.

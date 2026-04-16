# Photo Purge: Alle Fotodaten löschen

## Zusammenfassung

Der Purge-Vorgang entfernt **unwiderruflich** sämtliche fotobezogenen Daten
einer Installation – Fotos, Alben, Gesichter, Personen, Embeddings,
Scan-Queue-Einträge und (optional) auch die Originaldateien sowie den
Thumbnail-Cache. Benutzerkonten, Rollen und Berechtigungen bleiben erhalten.

Das Feature ist als **Danger Zone** in der Datenverwaltung umgesetzt und durch
eine eigene Berechtigung (`photos.purge`) sowie eine Tipp-Bestätigung
(`LÖSCHEN`) gegen versehentliche Auslösung abgesichert.

## Wann sollte man purgen?

Typische Anwendungsfälle:

- **Frische Test-/Demo-Umgebung** ohne den Container neu aufzubauen.
- **Vollständiger Reset** vor einem Re-Import einer kuratierten Bibliothek.
- **Bereinigung von verwaisten Embeddings** nach einem fehlgeschlagenen
  Migrations- oder Backup-Vorgang.

> Für das selektive Entfernen einzelner Fotos gibt es weiterhin den normalen
> `DELETE /photos/:id`-Endpunkt mit `photos.delete`. Purge ist explizit der
> "alles auf Anfang"-Knopf.

## Berechtigungsmodell

```
permissions
└── photos.purge   -- "Purge all photo-related data (destructive)"
```

| Rolle             | `photos.purge`           |
|-------------------|--------------------------|
| Admin             | **NICHT** automatisch    |
| User              | nicht zugewiesen         |
| (eigene Rolle)    | manuell zuweisbar        |

`photos.purge` ist in [`db/seed.ts`](../db/seed.ts) explizit aus der
Default-Zuweisung der Admin-Rolle ausgenommen (`adminExcludedPermissions`).
Das ist eine bewusste Sicherheitsmassnahme: Selbst ein Admin kann erst
purgen, nachdem ein zweiter Admin (oder dieselbe Person als bewusster Akt)
die Berechtigung an eine Rolle vergeben hat. Der Seed-Job führt zusätzlich
einen defensiven Cleanup durch und entzieht die Berechtigung der
Admin-Rolle, falls sie aus früheren Versionen noch zugewiesen war.

Die Frontend-UI prüft `auth.hasPermission('photos.purge')` und blendet den
"Danger Zone"-Block ohne diese Berechtigung komplett aus.

## API

### Endpunkt

```
POST /photos/purge        (auth required, permission: photos.purge)
Content-Type: application/json

{ "deleteFiles": false }
```

| Feld          | Typ      | Bedeutung                                                  |
|---------------|----------|------------------------------------------------------------|
| `deleteFiles` | `boolean`| `true` = zusätzlich Originaldateien und Thumbnail-Cache löschen. `false` = nur Datenbank leeren, Dateien bleiben (verwaist) auf der Festplatte. |

### Antwort

```jsonc
{
  "success": true,
  "dbCounts": {
    "photo_scan_queue": 12,
    "photo_landmarks": 84,
    "user_face_assignments": 31,
    "faces": 119,
    "photo_group_members": 22,
    "photo_groups": 7,
    "album_photos": 156,
    "album_shares": 4,
    "album_public_links": 0,
    "album_user_settings": 9,
    "albums": 11,
    "persons": 8,
    "photo_curation": 84,
    "photos": 412
  },
  "files": {
    "deleted": true,           // == übergebenes deleteFiles
    "uploadsRemoved": 412,
    "thumbnailsRemoved": 412,
    "failures": 0
  },
  "embeddingService": {
    "called": true,
    "ok": true,
    "deleted": 412,
    "error": ""
  }
}
```

`dbCounts` listet die Anzahl gelöschter Zeilen pro Tabelle in der
**Reihenfolge der tatsächlichen Ausführung**, was die spätere Diagnose
(z.B. eines unerwartet leeren Tables) erleichtert.

`embeddingService` wird **immer** aufgerufen – auch wenn `deleteFiles=false`
ist. Sobald die `photos`-Tabelle leer ist, sind die Embeddings im
Vektor-Store ohnehin verwaist. Schlägt der Aufruf fehl (Service nicht
erreichbar etc.), wird der Fehler im Response-Feld gemeldet, der
DB-Teil des Purges gilt aber als erfolgreich.

## Implementierung

### Backend-Schichten

| Datei                                                           | Rolle                                                                 |
|-----------------------------------------------------------------|-----------------------------------------------------------------------|
| [`photo/photo.ts`](../photo/photo.ts) `purgePhotos`             | Encore.ts-Endpoint, prüft Auth + Permission, delegiert an die Logik.  |
| [`photo/photo.service.ts`](../photo/photo.service.ts) `purgeAllPhotosLogic` | Eigentliche Lösch-Sequenz, FK-sichere Reihenfolge, Datei- und Embedding-Cleanup. |
| [`embedding_service/app/api/endpoints.py`](../embedding_service/app/api/endpoints.py) `delete_all_photos` | Python-Endpoint `DELETE /photos`, leert den pgvector-Store.           |

### Lösch-Reihenfolge (FK-sicher)

Innerhalb von `purgeAllPhotosLogic` werden die Tabellen in einer
Reihenfolge geleert, die alle Foreign-Key-Abhängigkeiten respektiert
(Kinder vor Eltern):

```
photo_scan_queue
photo_landmarks
user_face_assignments
faces
photo_group_members
photo_groups
album_photos
album_shares
album_public_links
album_user_settings
albums
persons
photo_curation
photos
```

Anschliessend:

1. `DELETE` an den Embedding-Service (`/photos`).
2. Internen `_aiUserId`-Cache zurücksetzen, damit der nächste Lookup einen
   frischen Stand erhält.
3. Wenn `deleteFiles=true`: `UPLOAD_DIR` und `THUMBNAIL_DIR` rekursiv
   leeren (Verzeichnisse selbst bleiben bestehen, das `tmp`-Subverzeichnis
   wird neu angelegt, damit Folge-Uploads sofort wieder funktionieren).

Pro Eintrag aufgetretene Datei-Fehler werden gezählt (`files.failures`),
brechen den Purge aber nicht ab — ein einzelner blockierter Handle soll
nicht den restlichen Cleanup verhindern.

### Was bleibt erhalten

- `users`, `roles`, `permissions`, `role_permissions`, `user_roles`
- WebAuthn-Credentials, Passwort-Reset-Tokens, Sessions
- App-Konfiguration und Secrets
- Backup-Snapshots auf dem ZFS-Dataset
- Verzeichnisse `UPLOAD_DIR` und `THUMBNAIL_DIR` (nur Inhalt wird geleert)

## Frontend-UI

In [`frontend/src/views/DataManagementView.vue`](../frontend/src/views/DataManagementView.vue)
ist der Purge als eigener Bereich **Danger Zone** umgesetzt:

1. Der Bereich wird nur gerendert, wenn der eingeloggte User die
   Berechtigung `photos.purge` besitzt.
2. Klick auf "Alle Fotodaten löschen…" öffnet einen modalen Dialog.
3. Der Dialog erzwingt **zwei** Bestätigungen:
   - Auswahl des Modus (`Nur Datenbank` vs. `Datenbank + Dateien`)
   - Tippen des Schlüsselwortes `LÖSCHEN` (case-insensitive, getrimmt)
4. Erst dann wird der Bestätigungs-Button aktiv.
5. Nach dem Aufruf bleibt der Dialog offen und zeigt eine Tabelle mit den
   gelöschten Zeilen pro Tabelle, dem Datei-Cleanup-Status und dem
   Ergebnis des Embedding-Service-Aufrufs.

## Sicherheitsüberlegungen

- **Doppelt sicher**: Permission ist nicht Admin-default und Bestätigungs-
  text ist erforderlich. Beides muss wegfallen, damit ein Purge
  versehentlich ausgelöst werden kann.
- **Audit**: Der Endpunkt läuft als normale Encore.ts-API und ist damit in
  den Standard-Traces sichtbar (`encore run` Dev-Dashboard auf
  <http://localhost:9400/>).
- **Backups**: Vor einem Purge in produktiven Umgebungen sollte das in
  [`DEPLOYMENT.md`](../DEPLOYMENT.md#automatic-daily-backup-recommended)
  beschriebene ZFS-Snapshot-System sicherstellen, dass ein
  Anwendungs-konsistenter Snapshot existiert. Im Notfall lässt sich der
  Stand per `zfs rollback` (Variante A im DEPLOYMENT) komplett
  wiederherstellen.
- **Embedding-Service-Ausfall**: Schlägt der `DELETE /photos`-Aufruf an
  den Python-Service fehl, wird die Antwort entsprechend markiert. Der
  DB-State ist trotzdem konsistent (leer); die verwaisten Embeddings
  können später durch erneutes Aufrufen oder durch Neustart des
  Embedding-Containers entfernt werden.

## Verwandte Endpunkte

| Endpoint                       | Permission             | Scope                       |
|--------------------------------|------------------------|-----------------------------|
| `DELETE /photos/:id`           | `photos.delete`        | Einzelnes Foto              |
| `DELETE /photos/:id/hard`      | `photos.delete`        | Einzelnes Foto + Datei      |
| `POST   /photos/purge`         | `photos.purge`         | **Alle Fotos der Installation** |

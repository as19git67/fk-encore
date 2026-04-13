# Ähnliche Fotos – Gruppierung und Review

## Überblick

Das Feature erkennt visuell ähnliche Fotos (Serienaufnahmen, Mehrfachbelichtungen,
nahezu identische Duplikate) und präsentiert sie als Stapel. Der User kann jede
Gruppe im `PhotoCompareView` durchgehen, einzelne Fotos verstecken oder
favorisieren und die Gruppe am Ende als "erledigt" (reviewed) markieren.

Dieses Dokument beschreibt, wie die Gruppierung zustande kommt, wie sie sich
gegenüber geteilten Alben verhält und was passiert, wenn sich Gruppenmitglieder
nachträglich ändern.

## Datenmodell

| Tabelle | Zweck |
|---------|-------|
| `photo_groups` | Eine Zeile pro User pro Ähnlichkeits-Cluster. Enthält `user_id`, `cover_photo_id`, `reviewed_at`, `created_at`. |
| `photo_group_members` | M:N-Verknüpfung der Gruppe zu ihren Foto-Mitgliedern inkl. `similarity_rank`. |

Wichtig: `photo_groups` hat **keine** Album-Referenz. Gruppen sind **user-spezifisch**,
nicht album-spezifisch. Das heißt:

- Jeder User hat seine eigene Sicht auf Ähnlichkeits-Cluster.
- `reviewed_at` gilt nur für den einen User.
- Zwei User (z. B. Eigentümer und Teilnehmer eines geteilten Albums) haben
  separate Gruppen-Zeilen mit unabhängigem Review-Status.

## Erkennungs-Pipeline

Die Erkennung läuft in `findPhotoGroupsLogic(userId)` in `photo/photo.service.ts`:

1. **Foto-Sammlung** – Lädt alle Fotos, auf die der User Zugriff hat:
   - Eigene Fotos (`photos.user_id = userId`)
   - Fotos aus geteilten Alben (`album_shares` ⋈ `album_photos` ⋈ `photos`)
   - Beide Mengen werden per Map dedupliziert.

2. **Embedding-Abruf** – Holt DINOv2-Embeddings für alle gesammelten Foto-IDs
   vom Embedding-Service (`EMBEDDING_SERVICE_URL`).

3. **Fensterbasierter Paarvergleich** – Sortiert nach Zeitstempel und
   vergleicht jedes Foto nur mit Fotos innerhalb von 10 Minuten
   (`TIME_WINDOW_MS`). Paare mit Kosinus-Ähnlichkeit ≥ 0.90
   (`SIMILARITY_THRESHOLD`) werden per Union-Find verbunden.

4. **Cluster-Bildung** – Zusammenhangskomponenten mit mindestens 2 Mitgliedern
   werden zu Gruppen. Das Zentrum (höchste durchschnittliche Ähnlichkeit) wird
   zum `cover_photo_id`.

5. **Persistenz** – Schreibt neue Gruppen in einer Transaktion:
   - Löscht alle bestehenden **unreviewten** Gruppen des Users.
   - Preservt reviewte Gruppen über Member-Set-Vergleich (siehe unten).

## Review-Preservation und Snapshot-Logik

Der Review-Status ist an einen konkreten Member-Snapshot gebunden.

Beim Neuaufbau der Gruppen prüft `findPhotoGroupsLogic` für jedes frisch
berechnete Cluster:

```
für jede reviewte Gruppe:
  wenn Member-Set identisch  → neue Gruppe nicht erstellen (Gruppe bleibt reviewed)
  wenn Member-Set echte Teilmenge → alte reviewte Gruppe löschen (obsolet)
  sonst                           → unabhängig, alte reviewte bleibt bestehen
```

Das hat zwei Konsequenzen:

- **Unveränderte Cluster bleiben reviewed**: Solange die Mitglieder gleich
  sind, sieht der User die Gruppe nicht erneut.
- **Erweiterte Cluster werden erneut vorgelegt**: Kommt ein Foto dazu
  (z. B. Upload eines ähnlichen neuen Fotos, oder Hinzufügen eines Fotos in
  ein geteiltes Album), entsteht ein neues Cluster mit größerer Membermenge.
  Der Snapshot stimmt nicht mehr überein – es wird eine neue **unreviewte**
  Gruppe erstellt, und die alte reviewte (nun obsolet gewordene) Teilmenge
  wird gelöscht. Der User muss die erweiterte Gruppe einmal erneut bestätigen.

## Trigger für Neu-Gruppierung

`findPhotoGroupsLogic(userId)` wird an mehreren Stellen angestoßen:

| Ereignis | Getriggert durch | Für welche User |
|----------|------------------|-----------------|
| Embedding-Job fertig | `scan-worker.ts` | Alle User mit Zugriff auf das Foto (Eigentümer + alle Shared-Album-Teilnehmer), ermittelt via `getUsersWithPhotoAccess` |
| Album wird mit einem User geteilt | `shareAlbumLogic` | Der neu hinzugekommene Teilnehmer |
| Foto wird einem Album hinzugefügt | `addPhotoToAlbumLogic` | Alle Shared-User des Albums |
| Album-Freigabe wird entzogen | `removeAlbumShareLogic` | Der entfernte Teilnehmer (damit verlorene Fotos aus seinen Gruppen verschwinden) |
| Manueller Trigger | `POST /photos/find-groups` | Der aufrufende User |

Die Aufrufe sind Fire-and-Forget mit Error-Logging, damit das API-Response
nicht blockiert wird.

### Serialisierung pro User

Alle Trigger laufen durch `scheduleRegroup(userId)` (`photo.service.ts`). Diese
Funktion garantiert:

- **Mutex**: Pro User läuft höchstens eine `findPhotoGroupsLogic`-Instanz
  gleichzeitig.
- **Coalescing**: Kommen während einer laufenden Berechnung mehrere weitere
  Trigger an, werden sie zu genau einem Folge-Durchlauf zusammengefasst, der
  anschließend den neuesten DB-Stand sieht.

Das ist wichtig, weil `findPhotoGroupsLogic` zu Beginn seiner Transaktion alle
unreviewten Gruppen des Users löscht und anschließend die frisch berechneten
Cluster einfügt. Ohne Serialisierung könnten zwei parallele Trigger (z. B. ein
schneller "Foto 1 und Foto 2 ins Album"-Doppelklick) folgendermaßen
interagieren: der ältere Trigger hat einen kleineren Foto-Snapshot gelesen
(`[1]`), berechnet deshalb kein Cluster; commitet danach sein `DELETE` – und
räumt die Gruppe `{1,2}` weg, die der neuere Trigger gerade eingefügt hatte.

Der manuelle Endpoint `POST /photos/find-groups` wartet ebenfalls auf den
Scheduler (inkl. eines evtl. bereits vorgemerkten Folge-Durchlaufs) bevor er
die aktuellen Gruppenstatistiken zurückgibt.

## Darstellung im Frontend

### Generelle Mechanik

Die zwei Ansichten `PhotosView` ("Alle Fotos") und `AlbumDetailView` teilen die
gleiche UI-Logik:

- `listPhotoGroups()` wird beim Laden aufgerufen.
- Das Composable `usePhotoGrouping` bekommt `hiddenByStack` und `photoToGroup`
  übergeben.
- Für jede **unreviewte** Gruppe wird nur das Cover-Foto im Grid angezeigt;
  die restlichen Mitglieder werden via `hiddenByStack` ausgeblendet.
- Ein Klick auf den Stapel (`@stack-click`) öffnet `PhotoCompareView`.
- Der Button **"Gruppen bearbeiten (N offen)"** springt per
  `handleStartGroupReview` zur ersten unreviewten Gruppe.

### Album-spezifische Einschränkung

In der Album-Ansicht werden Gruppen zusätzlich auf die Album-Mitglieder
eingeschränkt (`albumPhotoGroups` in `AlbumDetailView.vue`):

```ts
// Vereinfachte Skizze
for (const g of photoGroupsList.value) {
  const membersInAlbum = g.photo_ids.filter(id => albumPhotoIds.has(id))
  if (membersInAlbum.length < 2) continue           // nicht relevant
  const coverInAlbum = albumPhotoIds.has(g.cover_photo_id)
    ? g.cover_photo_id
    : membersInAlbum[0]                              // ersatzweise
  result.push({ ...g, photo_ids: membersInAlbum, cover_photo_id: coverInAlbum })
}
```

Das heißt:

- Nur Gruppen mit **≥ 2 Mitgliedern im aktuellen Album** erscheinen.
- Mitglieder außerhalb des Albums werden aus der Gruppenansicht herausgefiltert.
- Ist das ursprüngliche Cover nicht im Album, wird ein album-internes Mitglied
  als Cover verwendet.

### Robustheit bei transienten Doppel-Gruppen

`photoToGroup` kann kurzfristig sowohl eine reviewte als auch eine unreviewte
Gruppe für dasselbe Foto enthalten (z. B. direkt nach dem Hinzufügen eines
Fotos in ein geteiltes Album, bevor die Aufräumlogik lief). Die Map-Aufbau-Logik
iteriert daher **erst reviewte, dann unreviewte** Gruppen – die unreviewte
gewinnt damit und steuert Stack-Icon und Klick-Verhalten.

## Szenario: Review im Teilalbum

Ausgangssituation:
- Gruppe G = {A, B, C} (alle drei sind visuell ähnlich).
- Geteiltes Album enthält nur A und B.
- Teilnehmer reviewt im Album.

Ablauf:

1. Teilnehmer öffnet Album → sieht Stapel [A, B] (C ist nicht im Album).
2. Teilnehmer kuratiert A und B (versteckt / favorisiert) und klickt **Fertig**.
3. `reviewPhotoGroup(id)` setzt `reviewed_at` auf seiner User-Gruppe [A, B].
4. Foto C wird nicht gesehen und nicht kuratiert.
5. Eigentümer fügt später C zum Album hinzu.
6. `addPhotoToAlbumLogic` triggert `findPhotoGroupsLogic(teilnehmer)`.
7. Neue Cluster-Berechnung: Teilnehmer sieht jetzt auch C → Cluster {A, B, C}.
8. Snapshot-Vergleich: {A,B,C} ⊃ {A,B} → alte reviewte [A, B] wird gelöscht,
   neue unreviewte [A, B, C] wird erstellt.
9. Teilnehmer öffnet Album → Button "Gruppen bearbeiten (1 offen)" erscheint,
   Stapel [A, B, C] ist sichtbar und kann erneut reviewed werden.

## Relevante Dateien

- `photo/photo.service.ts`
  - `findPhotoGroupsLogic` (Gruppierung + Preservation + Cleanup)
  - `getUsersWithPhotoAccess` (Eigentümer + alle Shared-User eines Fotos)
  - `reviewPhotoGroupLogic` (setzt `reviewed_at`)
  - `addPhotoToAlbumLogic`, `shareAlbumLogic`, `removeAlbumShareLogic`
    (triggern Re-Grouping für betroffene User)
- `photo/scan-worker.ts` – triggert Re-Grouping für alle User mit Zugriff,
  wenn ein Embedding-Job fertig wird.
- `db/schema.ts` – `photoGroups`, `photoGroupMembers`.
- `frontend/src/views/PhotosView.vue` – globale Ansicht.
- `frontend/src/views/AlbumDetailView.vue` – album-eingeschränkte Ansicht.
- `frontend/src/components/PhotoCompareView.vue` – Review-/Vergleichs-Overlay.
- `frontend/src/composables/usePhotoGrouping.ts` – Grid-Gruppierung inkl.
  Stack-Collapsing.

## Tuning-Konstanten

| Konstante | Wert | Ort |
|-----------|------|-----|
| `SIMILARITY_THRESHOLD` | 0.90 | `photo.service.ts` |
| `TIME_WINDOW_MS` | 10 Minuten | `photo.service.ts` |

Der hohe Schwellwert ist bewusst gewählt – Ziel sind Near-Duplicates /
Serien, keine thematisch ähnlichen Aufnahmen. Das Zeitfenster verhindert
False Matches zwischen getrennten Ereignissen.

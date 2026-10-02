# Foto-Freigabe (Review-/Genehmigungsprozess pro Album)

Status: **Plan, noch nicht umgesetzt.**

Hintergrund: Einsatz des Foto-Moduls bei der Feuerwehr. Fotos aus Einsätzen
dürfen erst sichtbar bzw. veröffentlicht werden, wenn eine berechtigte Person
(z. B. der Kommandant) zugestimmt hat.

## Ziel

- Pro Album abschaltbar: **„Freigabe erforderlich“**.
- Neu aufgenommene Fotos sind in so einem Album zunächst **nicht sichtbar**.
- Personen mit der **globalen** Berechtigung `photos.review` sehen alle
  wartenden Fotos aller freigabepflichtigen Alben in einer Ansicht
  „Freigaben“. Sie bekommen bei neuen Fotos eine Benachrichtigung (in der App,
  als Push und gebündelt als E-Mail).
- Prüfer wählen Fotos aus (auch mehrere auf einmal) und entscheiden über die
  **Freigabeklasse**:

| Klasse | Bedeutung | Gespeichert als |
|---|---|---|
| keine | nicht sichtbar (wartet oder abgelehnt) | `pending` / `rejected` |
| intern | angemeldete Teilnehmer des Albums mit `photos.view` | `internal` |
| öffentlich | zusätzlich über öffentliche Links und für Gäste | `public` |

- Bei öffentlich ausgelieferten Fotos werden die **Metadaten entfernt**
  (siehe Abschnitt „Datenschutz“).

## Designentscheidungen

### Status gehört an die Album-Mitgliedschaft, nicht an das Foto

Freigegeben wird ein Foto **in einem bestimmten Album**. Dasselbe Foto kann
auch in einem privaten Album ohne Freigabepflicht liegen, und dort darf
nichts blockiert werden. Öffentliche Links (`album_public_links`) und Gäste
hängen ebenfalls am Album. Deshalb bekommt `album_photos` den Status und nicht
`photos`.

Die bestehende Regel `photos.link_visibility` (mit `auto` für erkannte
Gesichter) bleibt als **zusätzlicher** Filter für öffentliche Links bestehen.
Öffentlich sichtbar ist ein Foto nur, wenn `release_state = 'public'` gilt
**und** `linkVisiblePhotoSql` zutrifft.

### Globale Prüferrolle

- Neue Berechtigung `photos.review` mit der Beschreibung „Fotos in
  freigabepflichtigen Alben prüfen und freigeben“.
- Neue Seed-Rolle **„Foto-Prüfer“** in `db/seed.ts` (`defaultRoles` und
  `rolePermissionsMap`) mit `module.photos`, `photos.view` und
  `photos.review`. Sie muss in den Seed, weil eine von Hand vergebene
  Berechtigung an einer verwalteten Rolle beim nächsten Start wieder entfernt
  wird. Admin bekommt `photos.review` automatisch.
- Prüfer brauchen **keine** Freigabe des Albums für sich (`album_shares`). Die
  Review-Endpunkte prüfen nur `photos.review`. Die normale Albumansicht bleibt
  an Besitzer und Teilnehmer gebunden.

### Wer darf die Freigabepflicht schalten?

- **Einschalten:** der Albumbesitzer oder ein Prüfer.
- **Ausschalten:** nur ein Prüfer. Sonst könnte der Besitzer die Prüfung
  einfach umgehen.
- **Beim Einschalten an einem bestehenden Album** fragt ein Dialog, was mit
  den vorhandenen Fotos geschieht: „intern freigeben“ (Voreinstellung) oder
  „alle zur Prüfung stellen“. Der Status `public` wird beim Einschalten nie
  vergeben.
- **Beim Ausschalten** werden alle `pending`-Fotos zu `internal`. `rejected`
  bleibt `rejected`.

### Wer sieht ein wartendes Foto?

- Prüfer sehen es in „Freigaben“.
- Die Person, die das Foto hinzugefügt hat (`added_by_user_id`), sieht es im
  Album mit einem Badge „Wartet auf Freigabe“ bzw. „Abgelehnt“ samt Grund.
  So wundert sich niemand, wo sein Upload geblieben ist.
- Alle anderen sehen es nicht. Das betrifft Listen, Zähler, das Cover, den
  Feed, Gäste und öffentliche Links.

### Abgelehnt heißt nicht gelöscht

Abgelehnte Fotos bleiben mit Status `rejected` in `album_photos`, damit die
Entscheidung nachvollziehbar bleibt und ein Prüfer sie zurücknehmen kann. Wer
das Foto hinzugefügt hat, kann es selbst aus dem Album entfernen.

## Datenmodell (Migration 0225)

```sql
ALTER TABLE albums
  ADD COLUMN review_required boolean NOT NULL DEFAULT false;

ALTER TABLE album_photos
  ADD COLUMN release_state text NOT NULL DEFAULT 'public'
    CHECK (release_state IN ('pending','rejected','internal','public')),
  ADD COLUMN reviewed_by_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN reviewed_at timestamptz,
  ADD COLUMN review_note text;

CREATE INDEX album_photos_pending_idx
  ON album_photos (album_id, added_at)
  WHERE release_state = 'pending';

-- Zeitpunkt der letzten Sammel-E-Mail je Prüfer
CREATE TABLE photo_review_mail_state (
  user_id integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  last_sent_at timestamptz NOT NULL
);

ALTER TYPE feed_item_kind ADD VALUE 'photo_review_pending';
ALTER TYPE feed_item_kind ADD VALUE 'photo_review_decided';
```

- Der Default `public` bei bestehenden Zeilen bewahrt das **heutige
  Verhalten** aller Alben ohne Freigabepflicht. Ein Album ohne Freigabepflicht
  setzt beim Hinzufügen weiterhin `public`, eines mit Freigabepflicht
  `pending`.
- `db/schema.ts` wird nachgezogen und `meta/_journal.json` bekommt den Eintrag
  `idx 225`.
- `ALTER TYPE … ADD VALUE` darf nicht in derselben Transaktion verwendet
  werden, in der der Wert angelegt wird. Das ist hier unkritisch, muss aber im
  Test bedacht werden.

## Backend

### 1. Ein zentrales Sichtbarkeitsprädikat

Neue Datei `photo/album-release.service.ts`:

- `albumPhotoVisibleSql(alias, viewerId)`: wahr, wenn
  `release_state IN ('internal','public')` gilt oder
  `added_by_user_id = viewerId`.
- `albumPhotoPublicSql(alias)`: wahr bei `release_state = 'public'`. Wird mit
  `linkVisiblePhotoSql` UND-verknüpft.
- `initialReleaseState(albumId)`: `pending` oder `public`.

**Alle** Stellen, die Albumfotos lesen oder einfügen, verwenden diese
Helfer. Die Analyse hat folgende Stellen gefunden. Die Liste vor der Umsetzung
noch einmal mit `grep album_photos` abgleichen.

Lesen:
- `getAlbumLogic` / `getAlbumPhotosLogic` (`photo.service.ts` ~4501/4793),
  einschließlich der Ansichten, Kurationsstatistik und Kartenansicht.
- `listAlbumsLogic` (~4389): Fotozähler und Cover. Prüfer und Hinzufügende
  bekommen zusätzlich `pending_count`.
- `getPublicAlbumLogic` (~5828) und `link-visibility.service.ts`.
- `photo/photo-file-access.ts` für den `?share=`-Pfad und den Cover-Fallback.
  Hier muss dieselbe Regel gelten wie in der Liste. Bei dieser Gelegenheit
  wird die vorhandene Abweichung bei `source='adopted'` angeglichen.
- `web/static.ts` (Open-Graph-Cover).
- Galerie-Filter `albumIds` / `albumHighlight` (`photo.filters.ts`),
  Content-Feed/Stream, Rückblicke, ZIP-/Album-Export.

Schreiben:
- `addPhotoToAlbumLogic` (~4985) und `batchUpdateAlbumPhotosLogic` (~5222).
- `attachToAutoAlbum` in `libraries.service.ts` (~496). Diese Funktion
  schreibt **direkt** in `album_photos` und umgeht die Logik oben. Sie muss
  ebenfalls `initialReleaseState` verwenden.

### 2. Nebenwirkungen erst bei Freigabe

Heute löst das Hinzufügen eines Fotos Gesichtszuordnung, Feed
(`photo_added`), Content-Feed, Realtime und Gast-Benachrichtigung
(`sharedalbum.fanoutAlbum`) aus. Bei `pending` passiert davon **nichts**,
außer:

- einem Realtime-Event an die Prüfer, damit der Zähler im Badge stimmt, und
- dem Feed-Eintrag `photo_review_pending` an alle mit `photos.review`
  (`user.listUserIdsWithPermission`), gebündelt über
  `scheduleEmitFeedItems`.

Die Nebenwirkungen werden in eine Funktion `onPhotosReleased(albumId,
photoIds, level)` ausgelagert, die beim Hinzufügen in Alben ohne
Freigabepflicht und bei der Freigabe aufgerufen wird. Gäste werden nur bei
`public` benachrichtigt.

### 3. Review-API (`photo/photo-review.ts`)

Alle Endpunkte verlangen `auth: true`, `module.photos` und `photos.review`.
Ausgenommen ist das Einschalten durch den Besitzer.

| Methode | Pfad | Zweck |
|---|---|---|
| GET | `/photo-review` | Liste nach Status (`pending` als Voreinstellung, `rejected`, `decided`) und Album, seitenweise, mit Gesamtzahl |
| GET | `/photo-review/count` | Zahl der wartenden Fotos für das Badge |
| POST | `/photo-review/decide` | `{ items: {albumId, photoId}[], decision: 'internal'\|'public'\|'rejected', note? }` |
| PATCH | `/albums/:id/review` | `{ required: boolean, existing?: 'internal'\|'pending' }` |

- `decide` darf auch bereits entschiedene Fotos umstufen, etwa von
  öffentlich auf intern oder von abgelehnt auf intern. Es setzt
  `reviewed_by/at/note`, ruft `onPhotosReleased` auf und schreibt an die
  Hinzufügenden einen `photo_review_decided`-Feed-Eintrag.
- Wird ein Foto von öffentlich auf intern oder abgelehnt herabgestuft,
  verschwindet es sofort aus den öffentlichen Links. Die Dateizugriffsprüfung
  greift bei jedem Request, Browser-Caches sind `private`.

### 4. Benachrichtigungen

- **In der App:** Feed-Einträge (siehe oben) und das Badge an „Freigaben“.
- **Push:** über das vorhandene `push.fanoutFeed`. Neue `NotificationKind`
  `photo_review`, die im Profil abschaltbar ist.
- **E-Mail:** neuer Cron `photo/review-digest-cron.ts` über `lib/local-cron.ts`
  `everyMs(15 min)`, nach dem Muster von `sharedalbum/digest-cron.ts`:
  - Je Prüfer mit wartenden Fotos, die nach `last_sent_at` hinzugekommen sind,
    und einer Ruhephase von 30 Minuten seit dem letzten Neuzugang wird **eine**
    E-Mail verschickt: „In 2 Alben warten 37 Fotos auf Freigabe“, mit Liste
    und Link auf `/fotos/freigaben`.
  - Neue Funktion `sendPhotoReviewDigestEmail` in `user/mail.ts`.
  - Ohne SMTP-Konfiguration wird die Nachricht nur ins Log geschrieben (wie
    bisher).
  - Abschaltbar über `notification_prefs` (`photo_review_email`).
- **Zur Nachvollziehbarkeit** wird der Job in `scheduled_job_state` eingetragen
  und erscheint damit in der Jobübersicht.

## Frontend

- **Neue Seite „Freigaben“** (`frontend/src/views/PhotoReviewView.vue`, Route
  `fotos/freigaben`, `meta.permission: 'photos.review'`):
  - Das Menü in `config/modules.ts` zeigt die Zahl der wartenden Fotos als
    Badge, nach dem Muster von `feedBadge.ts`.
  - Aufbau mit `PageLayout`, `ListToolbar` (Filter nach Album und Status) und
    einem nach Alben gruppierten Raster.
  - Mehrfachauswahl über `useListSelection` + `SelectionBar` mit den Aktionen
    **„Intern freigeben“**, **„Öffentlich freigeben“** und **„Ablehnen…“**
    (Dialog `dialog-sm` mit optionalem Grund).
  - In der Vollbildansicht stehen dieselben drei Aktionen zur Verfügung. Dazu
    werden die Metadaten (Ort/Karte, Aufnahmezeit, Gesichter) angezeigt, damit
    der Prüfer weiß, was er gerade veröffentlicht.
  - Tastenkürzel: `I` / `Ö` (bzw. `P`) / `A`.
  - Name bewusst **nicht** „Review“, um eine Verwechslung mit dem vorhandenen
    `ReviewQueueView` („Gruppen-Review“) zu vermeiden.
- **Albumdetail:**
  - Ein Schalter „Freigabe erforderlich“ in den Albumeinstellungen, einschließlich
    des Dialogs für bestehende Fotos.
  - Ein Hinweis im `#notice`-Slot: „12 Fotos warten auf Freigabe“, für Prüfer
    mit Link auf die Freigabeseite, die nach diesem Album gefiltert ist.
  - Für die Hinzufügenden ein Badge auf ihren wartenden bzw. abgelehnten
    Fotos.
  - Für Prüfer ist die Freigabeklasse auch im Album umstellbar, über
    Auswahlaktionen.
- **Albenliste:** Kennzeichnung (Icon) für freigabepflichtige Alben.
- **Profil:** zwei neue Schalter in `NOTIFICATION_TYPES` (Push und E-Mail für
  Freigaben).
- **Storybook-Stories** für `PhotoReviewView` und die Badges, damit die
  Prüfungen auf Überlauf und Fokusring greifen.

## Datenschutz: Metadaten entfernen

**Ja, das wird gebraucht.** Die Analyse hat zwei konkrete Lücken gefunden:

1. `getPublicAlbumLogic` liefert an **anonyme** Aufrufer `latitude`,
   `longitude` und `location_*` jedes Fotos aus. Damit ist der Einsatzort
   exakt bestimmbar.
2. `GET /photos/file/*` streamt ohne `?w=` das **Original unverändert**, mit
   allen EXIF-, IPTC- und XMP-Daten (GPS, Kameraseriennummer, Software,
   Aufnahmezeit, ggf. Name des Fotografen).

Vorkleinerte Bilder (`?w=`) sind schon heute sauber, weil sharp ohne
`withMetadata()` keine Metadaten schreibt.

Maßnahmen:

- **Öffentlicher Zugriff** (`?share=`-Token, Gäste, Open-Graph-Bild):
  - Es wird **nie** das Original ausgeliefert. Ohne `?w=` gibt es eine
    bereinigte Vollauflösung: sharp `.rotate()` und Neukodierung als JPEG, mit
    ICC-Profil, ohne EXIF/XMP/IPTC. Der Cache-Schlüssel bekommt das Suffix
    `_clean`.
  - Die JSON-Antwort lässt Koordinaten weg. Optional bleibt eine grobe
    Ortsangabe (`location_city`), abhängig von einer Album-Option „Ort öffentlich
    anzeigen“ (Voreinstellung: aus).
  - Die Beschreibung (`description`) bleibt, weil sie der Freigebende sieht.
- **Interner Zugriff:** bleibt unverändert, denn angemeldete Mitglieder sollen
  den Kontext sehen. Optional später eine globale Einstellung „GPS auch intern
  ausblenden“.
- **Download/Export für Gäste:** nutzt dieselbe bereinigte Variante.
- **Hinweis:** Gesichter auf Fotos sind ebenfalls personenbezogene Daten. Die
  vorhandene `link_visibility = auto`-Regel (Fotos mit erkannten benannten
  Personen bleiben aus öffentlichen Links heraus) greift weiterhin. Der
  Prüfer sieht im Freigabedialog, wenn sie zuschlägt. Es wird dann angezeigt
  „Wird trotz Freigabe nicht öffentlich gezeigt, weil benannte Person
  erkannt“, mit der Möglichkeit, das zu übersteuern.

## Bekannte Grenze

Jeder angemeldete Nutzer mit `photos.view` darf heute **jede** Datei per
`/photos/file/<name>` abrufen (`photo-file-access.ts`). Ein wartendes Foto ist
also für jemanden, der den Dateinamen kennt, technisch abrufbar. Dateinamen
sind nicht erratbar und tauchen in keiner Liste auf. Eine Verschärfung (Datei
nur bei Besitz, sichtbarer Album-Mitgliedschaft oder `photos.review`) ist als
eigene, spätere Etappe vorgesehen, weil sie Galerie, Personen und Suche
gleichermaßen betrifft.

## Etappen

1. **Datenmodell, Berechtigung, Sichtbarkeit:**
   - Migration, Schema, Seed (`photos.review`, Rolle „Foto-Prüfer“).
   - `album-release.service.ts`, Anpassung aller Lese- und Schreibstellen
     einschließlich `attachToAutoAlbum`.
   - Tests:
     - Ein Album ohne Freigabepflicht verhält sich unverändert.
     - Ein wartendes Foto ist unsichtbar für Teilnehmer, öffentliche Links und
       den `?share=`-Dateizugriff, aber sichtbar für die hinzufügende Person.
2. **Review-API und Nebenwirkungen:**
   - `photo-review.ts`, `onPhotosReleased`, Ein- und Ausschalten.
   - Tests: Rechte, Batch-Entscheidung, Herabstufung, Feed und Gäste erst bei
     Freigabe.
3. **Benachrichtigungen:** Feed-Kinds, Push-Kind, E-Mail-Digest-Cron und
   Einstellungen. Tests für den Cron (Ruhephase, eine E-Mail je Prüfer,
   Opt-out).
4. **Frontend:** Freigabeseite, Badge, Albumschalter, Markierungen, Profil,
   Stories.
5. **Metadaten:** bereinigte Auslieferung für den öffentlichen Zugriff,
   Bereinigung der JSON-Antwort, Album-Option „Ort öffentlich anzeigen“.
   Tests: Die öffentliche Datei enthält kein GPS (mit `exifr` prüfen).
6. **(Optional)** iOS-App: Freigabeansicht und Badges; die Verschärfung des
   Dateizugriffs; Dokumentation in `docs/`.

## Offene Fragen

- **„Intern“:** Gilt das für die Teilnehmer des Albums (Besitzer und Personen,
  für die das Album freigegeben ist), wie hier angenommen? Oder sollen
  intern freigegebene Fotos aus freigabepflichtigen Alben für **alle** Nutzer
  mit `photos.view` sichtbar sein, also eine Art „Feuerwehr-Album für alle“?
- Soll ein Prüfer, der selbst Fotos hinzufügt, diese ohne Prüfung direkt
  freigeben dürfen (Selbstfreigabe), oder gilt das Vier-Augen-Prinzip?

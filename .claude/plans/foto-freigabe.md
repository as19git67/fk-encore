# Foto-Freigabe (Genehmigungsprozess für Fotos)

Status: **Plan, noch nicht umgesetzt.** Zweite Fassung nach Rückmeldung des
Nutzers. Die erste Fassung hatte den Status pro Album-Mitgliedschaft
vorgesehen, die Freigabe hängt jetzt am Foto.

Hintergrund: Einsatz des Foto-Moduls bei der Feuerwehr. Fotos aus Einsätzen
dürfen erst sichtbar bzw. veröffentlicht werden, wenn eine berechtigte Person
(z. B. der Kommandant) zugestimmt hat.

## Ablauf

```
Upload / Import ──► neu ──┬──► abgelehnt
                          ├──► genehmigt-intern  ──► (später) genehmigt-public
                          └──► genehmigt-public  ──► (später) genehmigt-intern
```

1. Ein hochgeladenes oder importiertes Foto landet im Zustand **neu**.
2. Genehmiger (globale Berechtigung `photos.review`) sehen alle neuen Fotos im
   speziellen Album **„Neu – zur Freigabe“**.
3. Der Genehmiger wählt ein oder mehrere Fotos aus und entscheidet:
   - **Ablehnen**, optional mit Grund, oder
   - **in ein Album einsortieren**, also genehmigen. Das ist immer mindestens
     *intern*. Zusätzlich kann er **„auch öffentlich“** setzen.
4. Neue Fotos lösen eine Benachrichtigung aus: in der App, als Push und
   gebündelt als E-Mail.

## Sichtbarkeit

Das ist die eine Regel, die überall gelten muss.

| Zustand | Hochladende Person | Genehmiger | Angemeldet mit `photos.view` | Nicht angemeldet |
|---|---|---|---|---|
| neu | ja (Badge „wartet“) | ja | nein | nein |
| abgelehnt | ja (Badge + Grund) | ja | nein | nein |
| genehmigt-intern | ja | ja | **ja** | nein |
| genehmigt-public | ja | ja | ja | **ja**, ohne Metadaten |

- **„Intern“** heißt: jeder angemeldete Nutzer mit `photos.view`, unabhängig
  von Albumfreigaben (`album_shares`).
- **Nicht angemeldete Nutzer** sehen ausschließlich `genehmigt-public`. Das
  gilt auf der neuen Einstiegsseite, bei öffentlichen Album-Links, für Gäste
  und beim Dateiabruf.
- Fotos außerhalb des Freigabeprozesses (`release_state IS NULL`, also alle
  bestehenden Fotos und alles, solange der Modus aus ist) verhalten sich wie
  heute.

## Designentscheidungen

### Status am Foto

Der Zustand gehört dem Foto (`photos.release_state`), weil die Genehmigung
eine Aussage über den Inhalt ist („darf gezeigt werden“). Die Albumzuordnung
ist das Einsortieren und passiert im selben Schritt.

### Freigabe-Alben

Die Alben, in die Genehmiger einsortieren, sind ein neuer Albumtyp
(`albums.release_album = true`). Er gehört der Organisation und nicht einem
einzelnen Nutzer:

- **Sichtbar** für alle mit `photos.view`. Der Inhalt ist auf genehmigte
  Fotos gefiltert. Ohne Anmeldung erscheint ein solches Album auf der
  Einstiegsseite, sobald es mindestens ein `public`-Foto enthält, und zeigt
  dort nur diese Fotos.
- **Anlegen, umbenennen, einsortieren, entfernen und Cover setzen** dürfen nur
  Genehmiger.
- Die vorhandenen persönlichen Alben (mit Besitzer, Shares und Links) bleiben
  unverändert. Auch dort gilt die Sichtbarkeitsregel oben: Ein neues Foto
  erscheint dort nur für die hochladende Person und für Genehmiger, und ein
  öffentlicher Link zeigt nur `public`-Fotos. Damit lässt sich die Freigabe
  nicht über ein privates Album umgehen.

### Globale Genehmigerrolle

- Neue Berechtigung `photos.review` mit der Beschreibung „Neue Fotos prüfen,
  in Alben einsortieren und freigeben“.
- Neue Seed-Rolle **„Foto-Genehmiger“** in `db/seed.ts` (`defaultRoles` und
  `rolePermissionsMap`) mit `module.photos`, `photos.view` und
  `photos.review`. Sie muss in den Seed, weil eine von Hand vergebene
  Berechtigung an einer verwalteten Rolle beim nächsten Start wieder entfernt
  wird. Admin bekommt `photos.review` automatisch.

### Modus pro Instanz einschalten

„Optional“ wird über eine **Instanzeinstellung** umgesetzt: „Freigabeprozess
aktiv“, umschaltbar unter Fotos › Einstellungen › Freigabe durch Personen mit
`photos.review` oder Admins. Ist sie aus, bekommen neue Fotos
`release_state = NULL` und alles bleibt wie heute. Eine allgemeine Tabelle für
Instanzeinstellungen gibt es noch nicht, sie entsteht hier (`app_settings`,
Schlüssel/Wert).

**Ausschalten bei laufendem Betrieb:** Fotos im Zustand *neu* bleiben *neu*,
bis jemand entscheidet. Sie werden nicht automatisch freigegeben. Ein Hinweis
in der Einstellung nennt die Anzahl.

## Datenmodell (Migration 0225)

```sql
CREATE TABLE app_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by_user_id integer REFERENCES users(id) ON DELETE SET NULL
);

ALTER TABLE photos
  ADD COLUMN release_state text
    CHECK (release_state IN ('new','rejected','internal','public')),
  ADD COLUMN release_reviewed_by_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN release_reviewed_at timestamptz,
  ADD COLUMN release_note text;

CREATE INDEX photos_release_new_idx ON photos (created_at)
  WHERE release_state = 'new';
CREATE INDEX photos_release_public_idx ON photos (id)
  WHERE release_state = 'public';

ALTER TABLE albums
  ADD COLUMN release_album boolean NOT NULL DEFAULT false,
  ADD COLUMN public_show_location boolean NOT NULL DEFAULT false;

CREATE TABLE photo_review_mail_state (
  user_id integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  last_sent_at timestamptz NOT NULL
);

ALTER TYPE feed_item_kind ADD VALUE 'photo_review_pending';
ALTER TYPE feed_item_kind ADD VALUE 'photo_review_decided';
```

- `NULL` bedeutet „nicht im Freigabeprozess“. Damit bleibt das Verhalten
  aller bestehenden Fotos unverändert.
- `db/schema.ts` wird nachgezogen und `meta/_journal.json` bekommt den Eintrag
  `idx 225`.

## Backend

### 1. Zentrale Sichtbarkeitsregel (`photo/photo-release.service.ts`)

- `releaseVisibleSql(alias, viewer)` setzt die Tabelle oben in SQL um. Dabei
  ist `viewer` eines von `{ userId, isReviewer }` oder `anonymous`.
  - **angemeldet:** `release_state IS NULL OR release_state IN
    ('internal','public') OR user_id = viewer OR isReviewer`
  - **anonym:** `release_state = 'public'`. Für Fotos mit `NULL` gelten die
    bisherigen Regeln für öffentliche Links (`linkVisiblePhotoSql`).
- `initialReleaseState()` liefert `'new'`, wenn der Modus aktiv ist, sonst
  `NULL`. Der Wert wird kurz gecacht.

Alle Stellen, die Fotos lesen oder anlegen, verwenden diese Helfer. Die
Analyse hat folgende Stellen gefunden. Die Liste vor der Umsetzung noch
einmal mit `grep` abgleichen.

Anlegen:
- `uploadPhotoLogic` / `uploadPhotoStream` (`photo.service.ts` ~2750/2886).
- `importFile` in `libraries.service.ts` (~653) und `attachToAutoAlbum`
  (~496). Diese Funktion schreibt direkt in `album_photos`. Ist der Modus
  aktiv, werden Auto-Alben für neue Fotos gar nicht erst befüllt, denn das
  Einsortieren macht der Genehmiger.

Lesen:
- Albenliste, Albumdetail und Albumfotos (`listAlbumsLogic`,
  `getAlbumLogic`, `getAlbumPhotosLogic`), jeweils mit Zählern, Cover,
  Ansichten und Karte.
- `getPublicAlbumLogic` und `link-visibility.service.ts`.
- `photo/photo-file-access.ts`: **neu** ist hier, dass auch angemeldete
  Nutzer mit `photos.view` neue oder abgelehnte Dateien fremder Fotos nicht
  mehr abrufen können. Anonym ist nur `public` erlaubt, und das immer in der
  bereinigten Fassung.
- Galerie und Suche (`photo.filters.ts`, `gallery-grid.ts`), Personen und
  Gesichter, Karte, Stream und Content-Feed, Rückblicke, Export/ZIP,
  Open-Graph (`web/static.ts`).

### 2. Nebenwirkungen erst bei Genehmigung

Ein neues Foto löst nur Folgendes aus:
- den Feed-Eintrag `photo_review_pending` an alle mit `photos.review`
  (`user.listUserIdsWithPermission`), gebündelt über
  `scheduleEmitFeedItems`, und
- ein Realtime-Event für den Badge-Zähler.

Gesichtszuordnung für andere, `photo_added`-Feed, Content-Feed und
Gast-Benachrichtigung laufen erst beim Einsortieren über
`addPhotoToAlbumLogic` bzw. `batchUpdateAlbumPhotosLogic`. Gäste werden nur
bei `public` benachrichtigt.

### 3. Freigabe-API (`photo/photo-release.ts`)

Alle Endpunkte: `auth: true`, `module.photos`, `photos.review`.

| Methode | Pfad | Zweck |
|---|---|---|
| GET | `/photo-release/queue` | Fotos nach Zustand (`new` als Voreinstellung, `rejected`, `internal`, `public`), seitenweise, mit Gesamtzahl |
| GET | `/photo-release/count` | Zahl der neuen Fotos für den Badge |
| POST | `/photo-release/approve` | `{ photoIds, albumIds: number[] (min. 1), public: boolean }`: einsortieren und Zustand setzen |
| POST | `/photo-release/reject` | `{ photoIds, note? }` |
| POST | `/photo-release/level` | `{ photoIds, level: 'internal'\|'public' }`: Freigabeklasse nachträglich ändern |
| GET/PUT | `/photo-release/settings` | Modus an/aus |

- Freigabe-Alben werden über die vorhandenen Album-Endpunkte angelegt
  (`release_album: true`). Die Rechte prüft `photos.review`.
- `approve` und `reject` setzen `release_reviewed_by/at/note` und schreiben an
  die hochladende Person einen `photo_review_decided`-Feed-Eintrag.
- Ein abgelehntes Foto kann der Genehmiger später doch noch genehmigen. Die
  hochladende Person kann es löschen.
- Herabstufen von public auf intern wirkt sofort, weil der Dateizugriff bei
  jedem Request geprüft wird.

### 4. Öffentliche Einstiegsseite (ohne Anmeldung)

Neue Endpunkte mit `auth: false` in `photo/public-gallery.ts`:

| Methode | Pfad | Inhalt |
|---|---|---|
| GET | `/public/albums` | Freigabe-Alben mit mindestens einem `public`-Foto: Name, Beschreibung, Anzahl, Cover (ein `public`-Foto) |
| GET | `/public/albums/:id` | Nur `public`-Fotos des Albums, ohne Koordinaten |

- Fotodateien werden über `/photos/file/*` angefordert. Anonym ist das für
  `release_state = 'public'` erlaubt und wird immer bereinigt ausgeliefert.
- Für diese Endpunkte gilt eine einfache Ratenbegrenzung pro IP.
- Frontend: neue Route `/galerie-oeffentlich` (Name `public-gallery`,
  eingetragen in `PUBLIC_ROUTE_NAMES`). Die Albumansicht übernimmt das Layout
  von `SharedAlbumView` (wird ggf. in eine gemeinsame Komponente ausgelagert).
  Auf der Login-Seite gibt es einen Link „Öffentliche Fotos ansehen“.
  Optional wird `/` ohne Anmeldung dorthin statt auf den Login umgeleitet;
  das ist per Einstellung steuerbar.

### 5. Benachrichtigungen

- **In der App:** Feed-Einträge (siehe oben) und der Badge am Album „Neu –
  zur Freigabe“ bzw. am Menüpunkt.
- **Push:** über `push.fanoutFeed`. Neue `NotificationKind` `photo_review`,
  im Profil abschaltbar.
- **E-Mail:** Cron `photo/release-digest-cron.ts` über `lib/local-cron.ts`
  mit `everyMs(15 min)`, nach dem Muster von `sharedalbum/digest-cron.ts`:
  - Je Genehmiger mit neuen Fotos, die nach `last_sent_at` hinzugekommen
    sind, und 30 Minuten Ruhe seit dem letzten Upload geht **eine** E-Mail
    raus: „37 neue Fotos warten auf Freigabe“, mit Uploadern, Zeitraum und
    Link.
  - Die E-Mail baut `sendPhotoReviewDigestEmail` in `user/mail.ts`. Ohne SMTP
    wird sie nur ins Log geschrieben.
  - Abschaltbar über `notification_prefs` (`photo_review_email`).
  - Erscheint in `scheduled_job_state` und damit in der Jobübersicht.

## Frontend

- **Album „Neu – zur Freigabe“:** Für Genehmiger steht es als erstes,
  virtuelles Album in der Albenliste, mit Zähler-Badge. Es öffnet
  `PhotoReleaseView.vue` (Route `fotos/freigabe`, `meta.permission:
  'photos.review'`).
  - Aufbau mit `PageLayout` und `ListToolbar`. Filter: Zustand (neu,
    abgelehnt, intern, öffentlich), hochladende Person, Zeitraum.
    Sortierung nach Aufnahmezeit oder Uploadzeit.
  - Mehrfachauswahl über `useListSelection` + `SelectionBar`. Hauptaktion
    **„Einsortieren…“**: ein Dialog `dialog-md` mit der Auswahl eines oder
    mehrerer Freigabe-Alben, „Neues Album…“ inline und dem Schalter **„Auch
    öffentlich freigeben“**. Daneben **„Ablehnen…“** (`dialog-sm`, optionaler
    Grund).
  - Vollbildansicht mit denselben Aktionen und angezeigten Metadaten (Ort und
    Karte, Aufnahmezeit, erkannte Personen). Ein Hinweis erscheint, wenn
    benannte Personen erkannt wurden.
  - Nach einer Entscheidung springt die Ansicht zum nächsten neuen Foto, damit
    ein Genehmiger zügig durcharbeiten kann.
  - Tastenkürzel: `E` einsortieren (mit dem zuletzt gewählten Album), `Ö`
    öffentlich umschalten, `A` ablehnen.
  - Name bewusst „Freigabe“ und nicht „Review“, um eine Verwechslung mit dem
    vorhandenen `ReviewQueueView` („Gruppen-Review“) zu vermeiden.
- **Freigabe-Alben:**
  - Markierung in der Albenliste.
  - Im Album zeigt jedes Foto für Genehmiger ein Symbol „öffentlich“.
  - Auswahlaktionen für Genehmiger: „Öffentlich freigeben“, „Nur intern“, „Aus
    Album entfernen“.
- **Eigene Uploads:** In Galerie und Alben tragen eigene Fotos im Zustand neu
  oder abgelehnt einen Badge. Der Grund erscheint per Tooltip bzw. in den
  Fotodetails.
- **Einstellungen:** Fotos › Einstellungen › Freigabe mit dem Schalter für den
  Modus und der Zahl der offenen Fotos.
- **Profil:** zwei neue Schalter in `NOTIFICATION_TYPES` (Push und E-Mail).
- **Storybook-Stories** für die Freigabeansicht, den Einsortieren-Dialog und
  die öffentliche Einstiegsseite (Prüfungen auf Überlauf und Fokusring).

## Datenschutz: Metadaten entfernen

**Wird gebraucht.** Die Analyse hat zwei Lücken gefunden, die heute schon bei
öffentlichen Album-Links bestehen:

1. `getPublicAlbumLogic` liefert an anonyme Aufrufer `latitude`, `longitude`
   und `location_*` aus, also den exakten Einsatzort.
2. `GET /photos/file/*` streamt ohne `?w=` das unveränderte Original mit
   EXIF, IPTC und XMP (GPS, Kameraseriennummer, Aufnahmezeit, ggf. Name des
   Fotografen).

Vorkleinerte Bilder (`?w=`) sind bereits sauber, weil sharp ohne
`withMetadata()` keine Metadaten schreibt.

Maßnahmen für jeden **anonymen** Zugriff (Einstiegsseite, Links, Gäste,
Open-Graph):

- **Nie** das Original ausliefern. Ohne `?w=` gibt es eine bereinigte
  Vollauflösung: sharp `.rotate()`, JPEG mit ICC-Profil, ohne
  EXIF/XMP/IPTC. Cache-Schlüssel mit dem Suffix `_clean`.
- Die JSON-Antworten enthalten keine Koordinaten. Der Ort (`location_city`)
  erscheint nur, wenn am Album `public_show_location` gesetzt ist
  (Voreinstellung: aus). Die Aufnahmezeit wird nur als Datum ausgegeben.
- Ein Download für Gäste nutzt dieselbe bereinigte Fassung.
- Gesichter: Die vorhandene Regel `link_visibility = auto` gilt für
  `public`-Fotos **nicht** automatisch, denn die ausdrückliche Freigabe durch
  den Genehmiger ist die Entscheidung. Der Einsortieren-Dialog weist aber
  darauf hin, wenn benannte Personen erkannt wurden.

Angemeldete Nutzer sehen weiterhin alle Metadaten.

## Etappen

1. **Datenmodell, Rolle, Sichtbarkeit:**
   - Migration, Schema, Seed, `app_settings`.
   - `photo-release.service.ts` und Anpassung aller Lese- und Anlegestellen
     einschließlich Dateizugriff.
   - Tests:
     - Mit Modus aus ist alles unverändert.
     - Ein neues Foto ist unsichtbar für andere Nutzer mit `photos.view`, für
       Links und anonym, aber sichtbar für die hochladende Person und für
       Genehmiger.
     - Ein internes Foto ist sichtbar für alle mit `photos.view`, aber nicht
       anonym.
2. **Freigabe-API:**
   - Einsortieren, Ablehnen, Klasse ändern, Freigabe-Alben und deren Rechte,
     Nebenwirkungen erst bei Genehmigung.
   - Tests: Rechte, Batch-Verarbeitung, Herabstufung.
3. **Öffentliche Einstiegsseite und Metadaten:**
   - Endpunkte `/public/*`, bereinigte Auslieferung, JSON ohne Koordinaten.
   - Test: Die anonym gelieferte Datei enthält kein GPS (mit `exifr`
     prüfen).
4. **Benachrichtigungen:** Feed-Kinds, Push-Kind, E-Mail-Digest und
   Einstellungen. Tests für den Cron (Ruhephase, eine E-Mail je Genehmiger,
   Opt-out).
5. **Frontend:** Freigabeansicht, Einsortieren-Dialog, Badges,
   Freigabe-Alben, öffentliche Einstiegsseite, Einstellungen, Profil,
   Stories.
6. **(Optional)** iOS-App: Badges, Freigabeansicht, Nutzung der öffentlichen
   Einstiegsseite. Dokumentation in `docs/`.

## Getroffene Annahmen

Sie lassen sich bei Bedarf ändern.

- **Selbstfreigabe:** Auch Fotos von Genehmigern landen in *neu*. Ein
  Genehmiger darf eigene Fotos selbst freigeben, es gibt also kein
  Vier-Augen-Prinzip.
- **Abgelehnte Fotos** werden nicht automatisch gelöscht. Das Löschen bleibt
  der hochladenden Person oder dem Genehmiger überlassen.
- Die Genehmigung verlangt **mindestens ein Album**. Ein freigegebenes Foto
  ohne Album gibt es nicht.

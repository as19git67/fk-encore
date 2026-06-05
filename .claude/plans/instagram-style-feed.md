# Instagram-artiger Content-Feed (chronologisch, betrachter-genau)

Status: **Plan** · Branch: `claude/instagram-style-feed-nnjJ2`

## Ziel

Ein zweiter Feed neben dem bestehenden **Benachrichtigungs-Feed** (`feed_items`):
ein scrollbarer **Content-Strom von Fotos** im Stil des Instagram-Haupt-Feeds —
große Post-Karten, Endlos-Scroll, Inline-Kommentare und Likes,
**streng deterministisch ohne Ranking-Algorithmus**.

Der bestehende `feed_items`-Feed (Activity/Benachrichtigungen, Herz-Icon-Tab)
**bleibt unverändert** und dient weiter als Benachrichtigungs-Tab.

## Kernentscheidungen (mit dem Nutzer abgestimmt)

### Feed-Einheit
- Einheit = **das Foto**, **einmal pro User**.
- Ein Foto erscheint im Feed von User A, wenn es in **mindestens einem Album**
  liegt, an dem A **teilnimmt** (Besitzer `albums.user_id` **oder** Eintrag in
  `album_shares`). Gäste (Link-Zugriff) sind ausgenommen.

### Sortierung: streng chronologisch nach „letzter relevanter Aktivität"
Sortierschlüssel = neuester der folgenden Ereignisse **pro Foto**:
1. Foto **ins Album hinzugefügt** (`album_photos.added_at`)
2. **Metadaten** editiert (Beschreibung/Keywords/Datum → `photos.updated_at`, per Trigger)
3. **Kommentar** erstellt/editiert (`photo_comments.created_at` / `edited_at`)

→ Verhalten = „zuletzt aktiv oben" (Bump), **kein** reines Erstell-Datum.
→ **Kein** Ranking, kein Engagement-Gewicht. Likes bumpen **nicht**.

### Betrachter-genau (Variante B)
Aktivität bumpt ein Foto **nur** im Feed der User, die das auslösende Album
sehen können. Beispiel: Kommentar in Album Z (A ist nicht dabei) bumpt das Foto
**nicht** in A's Feed, auch wenn A das Foto über Album X sieht.

Konsequenz: Der Sortierwert ist **pro (Foto, Betrachter)** → er muss
**materialisiert** werden (Fan-out), sonst ist stabile Cursor-Pagination
unmöglich. Reichweite der Ereignisse:

| Ereignis | bumpt für … |
|---|---|
| Foto in Album X hinzugefügt | Teilnehmer von X |
| Kommentar in Album X (erstellt/editiert) | Teilnehmer von X (`photo_comments.album_id`) |
| Metadaten editiert | **alle**, die das Foto sehen (global – jeder Betrachter „sieht" es) |

### Likes = bestehende Favoriten (kein neues Konzept)
`photo_curation` (PK `(user_id, photo_id)`, Status `visible|hidden|favorite`)
ist bereits ein per-User-Herz mit Aggregation und Fan-out (`photo_favorited`).
Der Feed-Like **ist** der Favorit-Toggle:

| Feed-Karte | Quelle |
|---|---|
| Herz gefüllt? | eigener `photo_curation.status === 'favorite'` |
| Like-Zähler | `count(*) WHERE photo_id=? AND status='favorite'` |
| Herz-Klick / Doppeltipp | bestehender `POST /photos/:id/curation` (`favorite` ↔ `visible`) |

- **Keine neue Tabelle, kein neuer Fan-out** — alles existiert schon.
- `hidden` bleibt unangetastet (Like schaltet nur `favorite ↔ visible`).
- XMP-Rückschreibung nur beim Eigentümer fürs eigene Foto (im Feed unkritisch).
- Like **bumpt den Feed nicht** (gehört nicht zu den Sortier-Kriterien).

## Datenmodell

Neue materialisierte Tabelle (per-User-Index des Content-Feeds):

```sql
CREATE TABLE photo_feed_entries (
  user_id          INTEGER     NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  photo_id         INTEGER     NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  last_activity_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id, photo_id)
);
CREATE INDEX idx_photo_feed_entries_timeline
  ON photo_feed_entries (user_id, last_activity_at DESC, photo_id DESC);
```

Lesen (trivial, indexgestützt, Cursor-stabil):

```sql
SELECT photo_id, last_activity_at
FROM photo_feed_entries
WHERE user_id = :A
  AND (last_activity_at, photo_id) < (:cursorTs, :cursorId)   -- Keyset-Cursor
ORDER BY last_activity_at DESC, photo_id DESC
LIMIT :limit;
```

## Fan-out- / Reconcile-Logik (das Herz von Variante B)

Neues Modul, eingehängt an dieselben Mutations-Stellen, die heute `emitFeed`
für den Benachrichtigungs-Feed aufrufen.

**Bump (monoton, nur hochsetzen) — `GREATEST(existing, ts)`:**
- `bumpForAlbumParticipants(photoId, albumId, ts)` — Add-to-Album, Kommentar
- `bumpForAllViewers(photoId, ts)` — Metadaten-Edit

**Reconcile (Soll-Betrachterkreis abgleichen, einfügen/löschen):**
- `reconcilePhotoViewers(photoId)` — nutzt bestehende `getUsersWithPhotoAccess()`;
  fügt fehlende Einträge ein, löscht verwaiste.

**Maintenance-Matrix:**

| Mutation | Aktion |
|---|---|
| Foto zu Album X hinzugefügt | bump Teilnehmer(X), initial `added_at` |
| Foto aus Album X entfernt | `reconcilePhotoViewers(photo)` (löscht, wer es nirgendwo noch sieht — bleibt) |
| Album X mit User U geteilt | Einträge für alle Fotos in X für U anlegen (Bump) |
| Freigabe entzogen / `album_left` | `reconcilePhotoViewers` für alle Fotos in X |
| Metadaten editiert | `bumpForAllViewers(photo, updated_at)` |
| Kommentar erstellt/editiert | `bumpForAlbumParticipants(photo, album_id, ts)` |
| Foto gelöscht | DB-CASCADE |
| Album gelöscht | `reconcilePhotoViewers` für betroffene Fotos |
| Like/Unlike (Favorit) | **kein** Bump |

Bei Familienarchiv-Größe (wenige Teilnehmer/Album) ist der Fan-out unkritisch.

## Etappen

### Etappe 1 — Datenschicht
- Migration `photo_feed_entries` (+ Index) unter `db/migrations/postgres/`.
- **`db/migrations/postgres/meta/_journal.json` pflegen** (sonst überspringt Drizzle die Migration → CI rot).
- Drizzle-Schema in `db/schema.ts` ergänzen.
- **Backfill** für Bestand: `last_activity_at = GREATEST(added_at, photos.updated_at, max(relevanter Kommentar))` je (User, Foto).
- `npm run test` grün → committen.

### Etappe 2 — Fan-out/Reconcile-Modul
- Neues Modul (z. B. `feed/content-feed.service.ts`), Bump/Reconcile-Helfer.
- An Mutations-Stellen in `photo/photo.service.ts` & `photo/reactions.service.ts` einhängen (neben bestehendem `emitFeed`).
- Tests für jede Maintenance-Zeile (add/remove/share/unshare/leave/metadata/comment).
- `npm run test` grün → committen.

### Etappe 3 — Lese-Endpoint
- `GET /feed/photos` — Keyset-Cursor `(last_activity_at, photo_id)`, Limit/Default wie bestehender Feed.
- Antwort je Post: Foto + Thumbnail/URL, Album-Kontext, Like-Zähler + `likedByMe`, Kommentar-Vorschau + Anzahl.
- Realtime-Event für Live-Prepend (analog `feed/item.added`).
- Tests → committen.

### Etappe 4 — Frontend
- Neue Ansicht (z. B. `FotoFeedView.vue`) + Route + API-Client.
- Post-Karten: Kopf (Avatar/Name/Album), Bild formatfüllend, Aktionsleiste (Herz/Kommentar), Bildunterschrift, Kommentar-Vorschau.
- **Endlos-Scroll** via IntersectionObserver (kein „Weitere laden"-Button).
- Herz = Favorit-Toggle (`POST /photos/:id/curation`), Doppeltipp-Geste, optimistisches Update.
- Inline-Kommentare über bestehende Reactions-API.
- Realtime-Prepend.
- Storybook-Story für Karte; Layout-Verifikation soweit möglich.
- `npm run test` grün → pushen.

## Offene Punkte
- Like-Zähler-Scope: global pro Foto (`count` aller Favorit-Zeilen) vs. nur
  Teilnehmer der für mich sichtbaren Alben — Vorschlag: global pro Foto (einfach, konsistent).
- Soll der Content-Feed den bestehenden `/fotos/feed` ersetzen oder als eigener
  Menüpunkt danebenstehen? Vorschlag: eigener Punkt; Benachrichtigungs-Tab bleibt.
- Carousel für Mehrbild-Posts (`payload.photoIds`) — optionale spätere Etappe.

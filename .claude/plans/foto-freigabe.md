# Photo release (approval workflow)

Status: **plan, not implemented yet.** Third revision. Earlier revisions had an
instance-wide switch, and the first one stored the state per album
membership.

## Background and scenario

A fire brigade runs the application in **its own instance**. Photos taken
during operations may only be shown, inside the brigade or publicly, once an
authorised person (e.g. the commander) has approved them.

In the same instance, some signed-in users (probably board members) use the
photo module **the way a family does today**: their own gallery, private
albums, shares, public links. In parallel they work with release albums.
Both modes have to coexist without interfering with each other.

## Workflow

```
Import volume (release inbox) ─┐
Upload link (anonymous)        ├──► new ──┬──► rejected
"Submit…" on an own photo      ─┘         ├──► approved-internal ◄──► approved-public
                                          └──► approved-public
```

1. A photo enters the workflow **explicitly**, through one of these:
   - a photo library flagged as **release inbox** (the existing import volume);
   - an **upload link** (anonymous upload, see below);
   - **"Submit for release…"** on an own photo, for users with
     `photos.release.submit`.

   Every other upload stays an ordinary photo (`release_state IS NULL`) and
   behaves exactly as today. There is no instance-wide mode switch.
2. Reviewers (global permission `photos.review`) see all new photos in the
   special album **"New – awaiting release"**.
3. A reviewer selects one or more photos and either
   - **rejects** them, with an optional reason, or
   - **sorts them into one or more release albums**, which approves them. That
     is always at least *internal*; the reviewer can also tick **"also
     public"**.
4. New photos notify reviewers in the app, by push and by a batched email.

## Visibility

This one rule has to hold everywhere: listings, counters, covers, file
access, public links, guests and feeds.

| State | Owner / submitter | Reviewer | Signed in with `photos.view` | Anonymous |
|---|---|---|---|---|
| `NULL` (not in the workflow) | as today | as today | as today: own photos and albums owned or shared | via the album's public link, as today |
| new | yes ("awaiting" badge) | yes | no | no |
| rejected | yes (badge + reason) | yes | no | no |
| approved-internal | yes | yes | **yes**, in release albums | no |
| approved-public | yes | yes | yes | **yes**, metadata stripped |

- **Internal** means any signed-in user holding `photos.view`. It is granted
  through a role, not to every user automatically. Note that the existing
  seeded role "Photo User" includes `photos.view`.
- **Anonymous** visitors only ever see approved-public photos: on the new
  public entry page, through public album links, as guests and when fetching
  files.
- **Private albums** keep working as today. They are no back door, though:
  a photo that is new or rejected never appears through an album's public link
  or to guests, even when it sits in a private album.

## Design decisions

### State on the photo, no copies

The state lives on the photo (`photos.release_state`), because approval is a
statement about the content. Sorting into an album happens in the same step.

**No file is copied and no second record is created.** Photos from the
release inbox and from upload links are owned directly by the system user
**"Organisation"**. When a board member submits an own photo, that photo
itself gets the state *new*; the member stays the owner and it stays in their
gallery and albums. The submitter is recorded separately
(`release_submitted_by_user_id`) so that the badge and notifications reach the
right person even when the owner is "Organisation".

### Release albums

The albums reviewers sort into are a new kind of album
(`albums.release_album = true`), owned by the system user "Organisation":

- **Visible** to everyone with `photos.view`. Their content is filtered to
  approved photos.
- **Anonymous** visitors see a release album on the public entry page once it
  holds at least one public photo, and only those photos.
- **Creating, renaming, sorting in, removing photos and setting the cover**
  are reserved for reviewers.
- The album list shows two sections: "My albums" and the organisation's
  albums. The organisation name is configurable, nothing says "Feuerwehr" in
  code.

### Roles and permissions

| Permission | Meaning |
|---|---|
| `photos.view` (existing) | internal viewer: may see approved photos in release albums |
| `photos.release.submit` (new) | may submit own photos for release |
| `photos.review` (new) | may review, sort, reject, change the release level, manage release albums and upload links |

New seeded roles in `db/seed.ts` (`defaultRoles` + `rolePermissionsMap`).
Hand-granted permissions on seeded roles are stripped on every boot, so they
have to be in the seed.

| Role | Permissions |
|---|---|
| "Foto intern" | `module.photos`, `photos.view` |
| "Foto-Genehmiger" | `module.photos`, `photos.view`, `photos.review`, `photos.release.submit` |

Admin gets the new permissions automatically. Board members combine "Photo
User" with "Foto-Genehmiger" or with `photos.release.submit`.

A user holding only "Foto intern" sees just the release albums in the photo
module. Gallery, people and recaps would be empty for them and are hidden.

### Self-approval

Photos from reviewers also land in *new*. A reviewer may approve their own
photos; there is no four-eyes rule. This can become a setting later.

### Rejected photos

Rejected photos are not deleted automatically. The reviewer, or the owner for
own photos, can delete them. Optional later: purge rejected photos older than
N days.

## Entry points

### A. Import volume as release inbox

Existing mechanism: `photo_libraries` with an owner, `auto_import` (chokidar
watcher in `photo/library-watcher.ts`) and optional `auto_albums`. New flag
`photo_libraries.release_inbox`:

- Imported photos get `release_state = 'new'`. They are owned by the library
  owner, normally "Organisation".
- `auto_albums` is ignored for release-inbox libraries, because sorting
  happens on approval. `attachToAutoAlbum` (`libraries.service.ts` ~496) has
  to respect this.
- Full scans (`scanLibrary`) and the reconcile cron (`library-cron.ts`) apply
  the same rule.

### B. Upload links (anonymous upload)

Works like the public album links, but in the other direction.

- **Creation:** a reviewer creates an upload link, e.g. "Einsatz 2026-10-03".
  - Fields: title, optional description, expiry (required, default 7 days),
    optional limits (max. files, max. total size), optional "ask for
    uploader name", optional target hint (the release album the reviewer will
    probably sort into, used as a pre-selection in the sort dialog).
  - It is shown as a URL and a **QR code**, to put on a vehicle or send by
    messenger.
  - It can be disabled at any time (soft delete, like `album_public_links`).
- **Usage:** whoever has the link opens `/upload/:token` without an account
  and gets a simple mobile-first page: pick or take photos, optional name,
  upload with a progress bar. The public entry page shows an upload button
  only while the visitor holds a valid link token (no open upload).
- **Server side:**
  - New `api.raw` endpoint `POST /upload-links/:token/photos`.
  - Streaming upload reusing `uploadPhotoStream`.
  - Owner "Organisation", `release_state = 'new'`, `upload_link_id` and the
    optional uploader name stored on the photo.
- **Safeguards:**
  - Only image formats, checked by magic bytes and not by extension, then
    decoded with sharp: if it cannot be decoded, it is rejected.
  - Per-file size limit.
  - Per-link and per-IP rate limit.
  - Duplicate detection by hash within the organisation; a duplicate is
    silently accepted and not stored twice.
  - Expired or disabled links answer 410.
  - No listing: the upload page never shows what others uploaded.
- **Notifications:** uploads through a link count like any other new photo
  (see Notifications). The reviewer sees the link title as the source.

### C. Submitting own photos

Board members with `photos.release.submit` get a "Submit for release…" action
in the gallery and in albums. It works on a selection, with an optional note
to the reviewer. It sets `release_state = 'new'` and
`release_submitted_by_user_id`. A submission can be withdrawn while the photo
is still *new*.

## Prerequisite: server-side access control (stage 0)

The analysis found that today **any user holding `module.photos` +
`photos.view` can fetch any photo of any user**, although the UI only lists
own photos and albums owned or shared:

- `/photos/file/*`: `denyPhotoFileRequest` (`photo/photo-file-access.ts:147`)
  lets every photo viewer through. Filenames are derived from the capture time
  (`YYYY/YYYY-MM/YYYY-MM-DD_at_HH.MM.SS_00.jpg`, `reserveStoragePath`) and can
  be enumerated.
- `GET /photos/:id/render` (`photo/photo.ts:1034`) only checks the
  permission. Photo IDs are sequential, and `?v=original` redirects to the
  original file.
- An audit of all endpoints that take an object id found further gaps. Album
  endpoints, listings, search, groups, recaps and realtime are scoped
  correctly; the problems are endpoints keyed by photo id and two
  person/face endpoints.
  - **Reads without an access check:**
    - `/photos/:id/export`: full resolution, enumerable by id.
    - `/photos/:id/ocr`: recognised text.
    - `/photos/:id/poi-matches`: place names.
    - `GET /photos/:id/transforms`: other users' names and edit recipes.
  - **Writes without an access check:** `PUT /photos/:id/transforms`,
    `/transforms/from-suggestion`, `/transforms/adopt`, and
    `/transforms/auto-levels`, which is an existence oracle and costs CPU.
  - **Person-name leak:** `POST /faces/:faceId/assign` does not check that
    `personId` belongs to the caller. `GET /photos/:id/faces` joins `persons`
    without a user filter. `PATCH /persons/:id` re-reads the record without a
    user filter, so it returns another user's person name and cover filename.
  - **Minor:**
    - `GET /photos/uploaders` lists every user who owns photos.
    - The `curation.changed` realtime event reaches members of every album
      holding the photo.
    - Guest comments ignore the public-link exclusions.
    - The photo owner can read comments in another user's private album that
      reused the photo.
  - The building blocks for the fix already exist: `getUsersWithPhotoAccess`
    (`photo.service.ts` ~782) and the checks in the curation and locations
    endpoints (~3640, ~5157).

This has to be fixed **before** the release workflow, as its own change.
Otherwise every internal viewer could fetch new and rejected photos, and every
user the board members' private photos.

- Add one central rule, `canSeePhoto(viewer, photoId)`. It is true for:
  - an own photo;
  - a photo in an own or shared album, or the cover of one;
  - later: a release album plus an approved state;
  - later: a reviewer looking at a photo in the workflow.
- Apply it to every endpoint that returns or changes a single photo, album,
  face or person.
- `/photos/file` is hit for every thumbnail. Use an indexed lookup plus a
  short per-user cache; signed image URLs are an option for later.
- Tests cover the legitimate cross-user paths: shared albums, faces and people
  from shared albums, group review, recaps, the AI user.

## Data model (one migration, next free number)

```sql
CREATE TABLE app_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by_user_id integer REFERENCES users(id) ON DELETE SET NULL
);
-- keys: 'photo_release.org_name', 'photo_release.org_user_id',
--       'photo_release.public_entry_enabled'

CREATE TABLE upload_links (
  id serial PRIMARY KEY,
  token text NOT NULL UNIQUE,
  title text NOT NULL,
  description text,
  created_by_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  target_album_id integer REFERENCES albums(id) ON DELETE SET NULL,
  ask_uploader_name boolean NOT NULL DEFAULT false,
  max_files integer,
  max_total_bytes bigint,
  expires_at timestamptz NOT NULL,
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE photos
  ADD COLUMN release_state text
    CHECK (release_state IN ('new','rejected','internal','public')),
  ADD COLUMN release_submitted_by_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN release_reviewed_by_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN release_reviewed_at timestamptz,
  ADD COLUMN release_note text,
  ADD COLUMN upload_link_id integer REFERENCES upload_links(id) ON DELETE SET NULL,
  ADD COLUMN uploader_name text;

CREATE INDEX photos_release_new_idx ON photos (created_at) WHERE release_state = 'new';
CREATE INDEX photos_release_public_idx ON photos (id) WHERE release_state = 'public';

ALTER TABLE albums
  ADD COLUMN release_album boolean NOT NULL DEFAULT false,
  ADD COLUMN public_show_location boolean NOT NULL DEFAULT false;

ALTER TABLE photo_libraries
  ADD COLUMN release_inbox boolean NOT NULL DEFAULT false;

CREATE TABLE photo_review_mail_state (
  user_id integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  last_sent_at timestamptz NOT NULL
);

ALTER TYPE feed_item_kind ADD VALUE 'photo_review_pending';
ALTER TYPE feed_item_kind ADD VALUE 'photo_review_decided';
```

- `release_state IS NULL` means "not in the workflow", so all existing
  photos behave as before.
- The system user "Organisation" is created by the seed, like `AI-Rating`. It
  cannot log in.
- Update `db/schema.ts` and add the entry to `meta/_journal.json`.

## Backend

### 1. Central visibility helper (`photo/photo-release.service.ts`)

- `releaseVisibleSql(alias, viewer)` implements the table above. `viewer` is
  `{ userId, permissions }` or `anonymous`. It is combined with the access rule
  from stage 0.
- `isPubliclyVisibleSql(alias)` combines `release_state = 'public'` with the
  existing public-link rules for `NULL` photos (`linkVisiblePhotoSql`). It also
  excludes `new` and `rejected` from every public link.

Places to adapt (re-check with `grep` before implementing):

- **Create:** `uploadPhotoLogic` / `uploadPhotoStream` (submit flag),
  `importFile` / `attachToAutoAlbum` / `scanLibrary` (release inbox), upload
  links.
- **Read:**
  - album list, detail and photos (`listAlbumsLogic`, `getAlbumLogic`,
    `getAlbumPhotosLogic`), including counters, cover, views and map;
  - `getPublicAlbumLogic`, `link-visibility.service.ts`,
    `photo-file-access.ts`, `web/static.ts` (Open Graph);
  - gallery filters, people and faces, stream and content feed, recaps,
    export.

### 2. Side effects only on approval

A new photo only triggers:
- the `photo_review_pending` feed item to everyone with `photos.review`
  (`user.listUserIdsWithPermission`), batched via `scheduleEmitFeedItems`;
- a realtime event for the badge counter.

Face assignment for other users, the `photo_added` feed, the content feed and
guest notifications only run when the photo is sorted in, through
`addPhotoToAlbumLogic` / `batchUpdateAlbumPhotosLogic`. Guests are notified
for public photos only.

### 3. Release API (`photo/photo-release.ts`)

All endpoints: `auth: true` and `module.photos`, plus the permission shown.

| Method | Path | Permission | Purpose |
|---|---|---|---|
| GET | `/photo-release/queue` | review | photos by state (default `new`; also `rejected`, `internal`, `public`), source (library, upload link, submitted), paged, with total |
| GET | `/photo-release/count` | review | number of new photos, for the badge |
| POST | `/photo-release/approve` | review | `{ photoIds, albumIds (min. 1), public }`: sort in and set the state |
| POST | `/photo-release/reject` | review | `{ photoIds, note? }` |
| POST | `/photo-release/level` | review | `{ photoIds, level: 'internal' \| 'public' }` |
| POST | `/photo-release/submit` | submit | `{ photoIds, note? }`, own photos only |
| POST | `/photo-release/withdraw` | submit | own photos, only while `new` |
| GET/POST/PATCH/DELETE | `/upload-links[...]` | review | manage upload links |
| GET/PUT | `/photo-release/settings` | review | organisation name, public entry page on/off |

- Release albums use the existing album endpoints (`release_album: true`),
  with permission checks against `photos.review`.
- `approve` and `reject` set `release_reviewed_by/at/note` and send the
  submitter a `photo_review_decided` feed item.
- Downgrading from public to internal takes effect immediately, because file
  access is checked on every request.

### 4. Public entry page (no login)

`auth: false` endpoints in `photo/public-gallery.ts`:

| Method | Path | Content |
|---|---|---|
| GET | `/public/albums` | release albums with at least one public photo: name, description, count, cover (a public photo) |
| GET | `/public/albums/:id` | the album's public photos only, without coordinates |
| GET | `/upload-links/:token` | title, description, limits, whether a name is requested (no photos) |
| POST | `/upload-links/:token/photos` | anonymous upload (see entry point B) |

- Anonymous file access through `/photos/file/*` is allowed for public photos
  and always served stripped.
- Rate limit per IP on all of these.
- **Frontend:**
  - Routes `/public` (album list and album view, layout taken over from
    `SharedAlbumView`) and `/upload/:token`, both added to
    `PUBLIC_ROUTE_NAMES`.
  - The login page links to "View public photos".
  - Optionally `/` redirects anonymous visitors there instead of to the
    login; controlled by a setting.

### 5. Notifications

- **In app:** feed items (above) and a badge on "New – awaiting release" and
  on the menu entry.
- **Push:** via `push.fanoutFeed`. New `NotificationKind` `photo_review`,
  which can be switched off in the profile.
- **Email digest:** `photo/release-digest-cron.ts` on `lib/local-cron.ts`
  `everyMs(15 min)`, modelled on `sharedalbum/digest-cron.ts`:
  - One email per reviewer with new photos since `last_sent_at`, once 30
    minutes have passed without new arrivals, e.g. "37 new photos awaiting
    release, 12 of them via upload link 'Einsatz 2026-10-03'". It lists
    sources and time range and links to the release view.
  - `sendPhotoReviewDigestEmail` in `user/mail.ts`. Without SMTP it only logs.
  - Opt-out via `notification_prefs` (`photo_review_email`).
  - Registered in `scheduled_job_state`, so it shows in the jobs view.

## Frontend

- **Release view** (`PhotoReleaseView.vue`, route `fotos/freigabe`,
  `meta.permission: 'photos.review'`). It opens from the virtual album "New –
  awaiting release", which is first in the album list for reviewers and
  carries a counter badge.
  - `PageLayout` + `ListToolbar`.
    - Filters: state, source (import volume, upload link, submitted by),
      period.
    - Sorting: capture time or upload time.
  - Multi-select via `useListSelection` + `SelectionBar`.
    - Primary action **"Sort in…"**: a `dialog-md` dialog to pick one or more
      release albums, with inline "New album…" and an **"Also public"**
      toggle. The upload link's target hint is pre-selected.
    - Secondary action **"Reject…"** (`dialog-sm`, optional reason).
  - Fullscreen view with the same actions and metadata (location and map,
    capture time, recognised people, source and uploader name).
  - After a decision the view advances to the next new photo.
  - Shortcuts: `E` sort in (last album), `P` toggle public, `R` reject.
  - It is called "Freigabe" in the UI and not "Review", to avoid confusion
    with the existing `ReviewQueueView` ("Gruppen-Review").
- **Upload links** (Fotos › Einstellungen › Upload-Links, for reviewers):
  - A list with title, expiry, number of uploads and status.
  - Create and edit in a `dialog-md` dialog.
  - Shown as a QR code with a "copy link" action.
  - Disabling asks for confirmation.
- **Upload page** (`/upload/:token`):
  - Mobile first: a large "Take or choose photos" button, optional name
    field, progress per file, and a short "Thank you, the photos will be
    reviewed" at the end.
  - No navigation into the rest of the app.
- **Public entry page** (`/public`): album tiles, and an album view with a
  fullscreen viewer.
- **Release albums:**
  - Shown as their own section in the album list.
  - A "public" icon on photos, visible to reviewers.
  - Selection actions "Make public", "Internal only", "Remove from album".
- **Own photos in the workflow:** a badge for new and rejected; the reason is
  in the tooltip and in the photo details. For `photos.release.submit` there
  are "Submit for release…" and "Withdraw submission".
- **Settings** (Fotos › Einstellungen › Freigabe): organisation name, public
  entry page on/off, number of open photos, and the release-inbox flag on the
  library settings page.
- **Profile:** two new toggles in `NOTIFICATION_TYPES` (push and email).
- **Storybook stories** for the release view, the sort-in dialog, the upload
  page and the public entry page, so the overflow and focus-ring checks apply.

## Privacy: stripping metadata

**Needed.** Two leaks already exist today on public album links:

1. `getPublicAlbumLogic` returns `latitude`, `longitude` and `location_*` to
   anonymous callers, so the exact location of an operation is exposed.
2. `GET /photos/file/*` without `?w=` streams the unmodified original with
   EXIF/IPTC/XMP: GPS, camera serial number, capture time, possibly the
   photographer's name.

Resized images (`?w=`) are already clean: sharp writes no metadata without
`withMetadata()`.

For every **anonymous** access (public entry page, public links, guests,
Open Graph):

- **Never** serve the original. Without `?w=`, serve a cleaned full-size
  version: sharp `.rotate()`, JPEG with the ICC profile, no EXIF/XMP/IPTC.
  Cache key suffix `_clean`.
- JSON responses carry no coordinates. The location (`location_city`) is shown
  only when `public_show_location` is set on the album (default off). Capture
  time is given as a date only.
- Guest downloads use the same cleaned version.
- **Faces:** the existing `link_visibility = auto` rule does **not**
  automatically apply to approved-public photos, because the reviewer's
  explicit approval is the decision. The sort-in dialog shows a warning when
  named people were recognised.

Signed-in users keep seeing all metadata.

Uploads through upload links keep their metadata in the original, so the
reviewer can see place and time. It is only stripped on anonymous delivery.

## Stages

0. **Server-side access control** (separate issue and PR, before
   everything else):
   - The `canSeePhoto` rule applied to file access, render, export, OCR,
     POI matches and transforms.
   - `personId` ownership on face assign, a user filter on person and face
     reads, and the minor findings listed above.
   - Tests for forbidden access to other users' photos and for every
     legitimate cross-user path.
1. **Data model, roles, visibility:**
   - Migration, schema, seed (permissions, roles, system user
     "Organisation"), `app_settings`.
   - `photo-release.service.ts`, adapting every read and create path.
   - Public links exclude new and rejected photos.
   - Tests:
     - `NULL` photos are unchanged.
     - A new photo is invisible to other viewers, links and anonymous
       visitors, and visible to the submitter and reviewers.
     - An internal photo is visible to `photos.view` but not anonymously.
2. **Entry points:** release-inbox flag on libraries (watcher, scan, cron)
   and submit / withdraw. Tests for each.
3. **Release API:**
   - Sort in, reject, change level, release albums and their permissions,
     side effects only on approval.
   - Tests: permissions, batches, downgrade.
4. **Upload links:**
   - Table, management API, anonymous upload endpoint with the safeguards.
   - Tests: expiry, limits, non-image rejection, rate limit, duplicates.
5. **Public entry page and metadata:**
   - `/public/*`, cleaned delivery, JSON without coordinates.
   - Test: the anonymously delivered file contains no GPS (checked with
     `exifr`).
6. **Notifications:** feed kinds, push kind, email digest and settings. Tests
   for the cron: quiet period, one email per reviewer, opt-out.
7. **Frontend:** release view, sort-in dialog, upload-link management with
   QR code, upload page, public entry page, release albums, badges,
   settings, profile, stories.
8. **(Optional)** iOS app (badges, release view, submit), purging rejected
   photos, a four-eyes setting, docs in `docs/`.

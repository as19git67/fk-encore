# Photo Comments – Album-Scoped Threads

## Overview

Users and share-link guests can comment on photos. Comments appear as a
threaded conversation in the photo detail view (`PhotoReactions.vue` for
logged-in users, `GuestPhotoReactions.vue` for guests on a public share
page), both rendered by the shared `PhotoCommentThread.vue` base.

This document describes how comments are scoped, who can see and write
them, and how they fan out to feeds, real-time clients and guest
notifications.

## Album scope

A photo can live in several albums at once (`album_photos` is M:N). The
defining rule of this feature is:

> A comment belongs to **exactly one album** — the album it was written
> in. It is only visible (and only fans out) within that album.

Example: user A shares album A and album B, and photo X is in both. If
user B comments on photo X while viewing it in album B, that comment is
visible only when photo X is shown in album B. Opening the same photo in
album A shows no such comment.

This is enforced by the `album_id` column on `photo_comments` (migration
`0093`). Listing, creating, editing, deleting and every fan-out path
filter by `album_id`.

### Consequence: comments require an album context

Because every comment must be bound to an album, commenting is only
possible inside an album view (the album detail page, or a public share
page — which always corresponds to one album's link). Views that show a
photo **outside** any album — the gallery and the persons view — have no
album to attach a comment to, so the "Reaktionen" section is not rendered
there at all (`PhotoDetailSidebar.vue` gates it on `albumId != null`).

## Data model

| Table | Purpose |
|-------|---------|
| `photo_comments` | One row per comment. |

```
photo_comments
  id          BIGSERIAL PK
  photo_id    FK → photos(id)   ON DELETE CASCADE   -- which photo
  album_id    FK → albums(id)   ON DELETE CASCADE   -- which album (NOT NULL)
  user_id     FK → users(id)    ON DELETE CASCADE   -- author (logged-in), nullable
  guest_id    FK → guests(id)   ON DELETE CASCADE   -- author (guest), nullable
  body        TEXT                                  -- max 2000 chars (service-enforced)
  created_at  TIMESTAMPTZ
  edited_at   TIMESTAMPTZ                           -- NULL until first edit
  CHECK: exactly one of (user_id, guest_id) is set  -- photo_comments_author_chk
```

Indexes:

- `idx_photo_comments_album_photo_created (album_id, photo_id, created_at ASC, id ASC)`
  — chronological listing of a photo's comments within one album.
- `idx_photo_comments_guest (guest_id) WHERE guest_id IS NOT NULL`
  — reverse lookup of a guest's comments (moderation).

### Migration 0093

`0093_album_scoped_comments.sql` adds `album_id`:

1. Add the column (nullable at first).
2. Backfill: each existing comment is attached to an album that actually
   contains its photo (`MIN(album_id)` over `album_photos`, deterministic).
3. Drop orphans: comments on photos that are in no album have no valid
   scope and are deleted.
4. Set `album_id NOT NULL`.
5. Create the composite index.

> Backfill picks any containing album because there is no historical
> album context to recover — a pre-0093 comment was never tied to one
> album. After 0093 all new comments carry their true album.

## Access rules (audience)

Because comments are album-scoped, the audience is computed **per album**,
not across every album that happens to contain the photo. The helper is
`getUsersWithAlbumPhotoAccess(albumId, photoId)` in
`photo/reactions.service.ts`:

- the photo owner,
- the owner of the album the comment lives in,
- users the **album** is shared with (`album_shares`).

It deliberately does **not** pull in members of *other* albums that also
contain the photo — that is exactly the leak this feature fixes.

> Contrast with `getUsersWithPhotoAccess(photoId)` (in `photo.service.ts`),
> which is album-wide (owner + all albums' shares). That function is still
> used elsewhere — e.g. the embedding/face-assignment pipeline — but is no
> longer used for comments.

`assertAlbumPhotoAccess(userId, photoId, albumId)` additionally checks
that the photo really is in the given album (`album_photos`) before a read
or write is allowed. Failures return `not_found` (rather than
`permission_denied`) so the API never leaks whether a photo or album
exists.

### Guests

A guest only ever reaches a photo through a public link whose album
contains it. `assertPhotoInPublicLink(photoId, publicLinkId)` validates
that and returns the link's `album_id`, which then scopes both reads and
writes. The guest API never needs to pass an album id — it is derived
server-side from the link.

## HTTP API

### Logged-in users (`photo/reactions.ts`, bearer auth, `photos.view`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/photos/:id/comments?albumId=…` | list a photo's comments in an album |
| POST | `/photos/:id/comments` | create a comment (`albumId` in body) |
| PATCH | `/photos/comments/:commentId` | edit own comment |
| DELETE | `/photos/comments/:commentId` | delete a comment |

`GET` requires the `albumId` query parameter and returns only that
album's comments. `POST` requires `albumId` in the body — it determines
the comment's scope and audience. `PATCH`/`DELETE` operate on a
`commentId` (whose `album_id` is already fixed) and check authorship; the
photo owner may delete any comment on their photo (moderation).

### Guests (`sharedalbum/comments.ts`, cookie session, raw endpoints)

| Method | Path | Purpose |
|---|---|---|
| GET | `/share/:token/photos/:photoId/comments` | list comments (read allowed for unverified guests) |
| POST | `/share/:token/photos/:photoId/comments` | create (verified guests only) |
| PATCH | `/share/:token/comments/:commentId` | edit own comment (verified) |
| DELETE | `/share/:token/comments/:commentId` | delete own comment (verified) |

The album is taken from the resolved public link, not from the request.

## Notifications & real-time

A single comment triggers up to three fan-outs, all scoped to the
comment's album. No fan-out loops over albums, and the recipient lists are
de-duplicated, so **one comment yields at most one notification per
recipient** — the multi-album membership of a photo does not multiply
notifications.

### 1. Feed item (logged-in audience)

```
emitFeedItem(recipients, actorUserId, "photo_commented", {
  albumId, photoId, payload: { commentId, excerpt }
})
```

`recipients` is the album-scoped audience minus the actor. `emitFeedItems`
de-duplicates recipients and writes one `feed_items` row each, then fires
a best-effort Web Push per recipient. `albumId` also drives the deep-link
so the notification opens the photo in the right album. Guest-authored
comments emit the same feed kind with `actorUserId = null` and a
`guestName` in the payload.

### 2. Real-time event (open photo views)

```
publishPhotoEvent(recipients, "commented" | "comment_updated" | "comment_deleted",
  photoId, { commentId, albumId, userId|guestId, … })
```

Every event carries `albumId` in its payload. `PhotoReactions.vue` only
reacts to an event when both `resourceId === photoId` **and**
`payload.albumId === albumId`, so a comment on the same photo in a
different album never updates the wrong thread.

### 3. Guest fan-out (`sharedalbum.fanoutPhoto`)

```
sharedalbum.fanoutPhoto({ photoId, albumId, kind: "comment_added",
  excludeGuestId?, payload: { commentId, authorName, excerpt } })
```

Resolves the `album → album_photos → album_public_links → guest_link_access`
chain and writes one `guest_notifications` row per opted-in, verified
guest of **that album's** links, then fires best-effort Web Push. Because
comments are album-bound, `albumId` is always set — there is no
cross-album fallback that could notify guests of another album. A guest
author is excluded from their own fan-out via `excludeGuestId`.

## Source map

| File | Responsibility |
|---|---|
| `photo/reactions.service.ts` | Comment CRUD, album-scoped access checks, audience, fan-out |
| `photo/reactions.ts` | User HTTP endpoints |
| `sharedalbum/comments.ts` | Guest HTTP endpoints (cookie session) |
| `sharedalbum/notifications.ts` | `fanoutPhoto` / `fanoutAlbum` → `guest_notifications` + Web Push |
| `feed/feed.service.ts` | `emitFeedItems` (feed rows, realtime, user Web Push) |
| `frontend/src/api/reactions.ts` | User comment API client |
| `frontend/src/api/sharedalbumComments.ts` | Guest comment API client |
| `frontend/src/components/PhotoReactions.vue` | User thread: load + realtime sync |
| `frontend/src/components/GuestPhotoReactions.vue` | Guest thread |
| `frontend/src/components/PhotoCommentThread.vue` | Shared presentational thread |
| `frontend/src/components/PhotoDetailSidebar.vue` | Gates the section on album context |
| `db/schema.ts` | Drizzle schema |
| `db/migrations/postgres/0093_album_scoped_comments.sql` | `album_id` + backfill |

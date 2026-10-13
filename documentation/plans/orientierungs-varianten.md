# Orientation variants: portrait and landscape of the same subject

Status: **Implemented** — stages 1–3 (PR #1421), 4 (PR #1425), 5 (PR #1426) and 6 (recaps and stream).

## Implementation status

- **Stage 1 (backend) — implemented.** Migration `0225_orientation_variants`
  (`photo_groups.orientation_variants`, `users.collapse_orientation_variants`).
  Rule and constant in `photo/orientation-variants.ts`
  (`VARIANT_TIME_WINDOW_SECONDS = 120`, named like `TIME_WINDOW_SECONDS` in
  `photo.service.ts`; the plan said `_MS`). That file holds the pure
  function `computeOrientationVariants` and the SQL predicate
  `orientationVariantSuppressedSql`, which `buildPhotoFilterConditions` applies for
  `variantMode=portrait|landscape` — so the filter applies to
  `/gallery/grid`, `/gallery/ids`, `/photos` and `/photos/index`. The
  user toggle and an `off` on the group are built into the SQL, no caller
  has to look them up. `GalleryGridEntry.orientation`, `Photo.orientation`,
  `GalleryGridGroup.variants`, `PhotoGroup.orientation_variants`/`variants`,
  `ReviewQueueGroup.orientation_pair`. Cover selection: if the grid shows only one
  side and the cover is on the other, the best-ranked member of the shown side
  carries `is_cover` (the database stays untouched). Endpoints:
  `PATCH /photos/groups/:id/variants` (`{ mode: 'auto' | 'off' }`),
  `GET`/`PATCH /photos/groups/orientation-variants` (`{ enabled }`). Tests in
  `photo/orientation-variants.test.ts` (time window, visibility, `off`,
  toggle, foreign group, cover, review queue) and `photo.filters.test.ts`.
- **Stage 2 (web grid + fullscreen) — implemented.** In addition to the counts,
  `GalleryGridGroup.variants` carries the photo IDs per side (`portrait_ids`,
  `landscape_ids`, best-ranked first), so the viewer knows the opposite side
  without a second query. On the web: `composables/useScreenOrientation.ts`
  (one source for the screen orientation), `utils/orientationVariants.ts`
  (side of an entry, opposite side, `variantModeFor`, `shouldSwitchSide`,
  `nextIndexSkippingCounterparts`), `composables/useVariantCursor.ts`
  (opposite side next to `cursorPhoto`, `toggle` with `pinned`, switch on
  rotation). `VirtualGallery` loads with `variantMode=<orientation>` and on
  rotation reloads around the visible anchor, in selection mode and with the
  filter toggle „Formatvarianten anzeigen" (show format variants; `showVariants` in the URL,
  chip „Inkl. Formatvarianten", incl. format variants) with `all`. Format badge (`.vg-variant-badge`,
  icon `pi pi-sync`) in the same corner as the stack badge, a tap opens
  fullscreen on the opposite side (`variant-click`). `FullscreenOverlay`: prop
  `variantPhoto`, button „Querformat"/„Hochformat" (landscape/portrait) with `R`, event
  `toggle-variant`, the opposite side is preloaded; the crossfade is the
  existing fade-in on load. `PhotoDetailSidebar` shows the file name of the
  opposite side. Paging skips the opposite side if the list
  holds both sides. The user toggle sits in the profile next to „Ähnliche Fotos" (similar photos; card
  „Hoch- und Querformat", portrait and landscape). Stories: `VirtualGallery.stories.ts` (landscape, portrait,
  both sides, selection mode) and two format-pair stories in
  `FullscreenOverlay` with `testViewport`. Tests: `useScreenOrientation`,
  `useVariantCursor`, `orientationVariants`.
- **Stage 3 (web review) — implemented.** Backend:
  `POST /photos/groups/:id/keep-best-per-orientation` (`bestPerOrientation`
  in `orientation-variants.ts`, runs via `acceptAiPickLogic`, favorites
  remain protected), review queue filter `orientationPair=true` via the
  SQL predicate `groupIsOrientationPairSql` (without the user toggle: whether two
  images are a pair is a property of the group). Web:
  `ReviewQueueView` with chip „Formatpaare" (format pairs; `pairs` in the URL), tag
  „Hoch + Quer" (portrait + landscape), button „Bestes je Format behalten" (keep best per format) and „Nicht dasselbe
  Motiv" (not the same subject) / „Als Formatpaar behandeln" (treat as format pair) directly on the card.
  `PhotoCompareView`: in a format pair only photos of the same
  orientation duel each other (`allowedDuel`), the best photo per side is never
  suggested for hiding (`bestPerSide`), and the final grid carries the
  note „bleiben als Formatpaar erhalten" (are kept as a format pair) with the toggle „Nicht dasselbe
  Motiv". `ReviewQueuePhoto.width/height` are declared in the frontend type.
  Stories: review queue with a format pair and with the chip active, compare as
  format pair.
- **Stage 4 (iOS grid, fullscreen, slideshow) — implemented.**
  `Core/Models/OrientationVariants.swift` (`PhotoOrientation`,
  `OrientationVariants` with side/opposite side per photo, `VariantMode.forScreen`,
  `OrientationVariantRules.shouldSwitchSide`, `SlideshowVariants`) and
  `Core/UI/ScreenOrientationEnvironment.swift` (`@Environment(\.screenOrientation)`,
  set once in `MainTabView` via `.providesScreenOrientation()`, plus
  `VariantBadge`). `PhotoWithCuration`/`Photo` carry `orientation`,
  `AlbumGroupReview.Group` carries `orientation_variants` and `variants`.
  `PhotosViewModel` loads `/photos` with `variantMode` and in parallel
  `/photos/groups`, from which `variantsByPhotoId` is built. `PhotoGridView`:
  side by screen, `all` in selection mode or with the filter
  „Formatvarianten anzeigen" (`PhotoFilter.showVariants`, toggle in
  `FilterSortMenuView`), reload on rotation around the topmost visible tile,
  badge at the top right opens the viewer on the opposite side.
  `PhotoFullscreenView`: the opposite side is loaded per side
  (`PhotoFetch.byId`) and shown **in place** (page index stays),
  button in the bottom bar, rotating switches automatically, a manual
  switch pins the side. `PhotoSlideshowView`: fetch opposite sides once via
  `PhotoFetch.byIds`, strike the opposite side of an earlier photo from the sequence,
  insert the fitting side per screen orientation (indices
  stay stable), only then does `SlideshowPlanner` pair the rest. Tests in
  `OrientationVariantsTests.swift`. Not done: second file name in the
  iOS detail view; the user toggle exists only in the web profile. Without Xcode
  in this environment the Swift code has not been compiled.
- **Stage 5 (iOS review) — implemented.** `CompareTournament` takes
  `formatPair:` and then excludes all portrait-versus-landscape pairs from the tournament
  (`crossOrientationPairs`, `totalPairs` does not count them, `isFormatPair`);
  `PhotoCompareView(photos:formatPair:)` passes it through, the review queue
  with `group.isOrientationPair`, the album review with `group.variants != nil`.
  `ReviewQueueGroup.orientation_pair` (decoded as optional, `isOrientationPair`,
  `hasBothOrientations`). Swipe gesture **↓ „Bestes je Format"** (best per format)
  (`ReviewSwipe.bestPerFormat`, only with `allowsDown` on a format pair,
  button in the action bar), decision `.keepBestPerOrientation` →
  `POST /photos/groups/:id/keep-best-per-orientation`. Context menu on the
  card: „Nicht dasselbe Motiv" (`PATCH …/variants` `off`) and back „Als
  Formatpaar behandeln" (`auto`), `ReviewQueueState.setOrientationPair` keeps
  the card up to date. Tag „Hoch + Quer" in the card header. Tests in
  `CompareTournamentTests` and `ReviewQueueTests`.
- **Stage 6 (recaps and stream) — implemented.** Backend:
  `counterpartsByPhotoId(userId, photoIds)` in `orientation-variants.ts`
  returns the best-ranked opposite side per photo (`OrientationCounterpart`
  with `id`, `filename`, `width`, `height`, `orientation`); `GET /recaps/:id`
  carries `counterparts[]`, `FeedPhotoItem` carries `counterpart`. Only the
  viewer's groups count, foreign photos in the stream have no
  opposite side. Web: `pickSideForScreen` in `utils/orientationVariants.ts` is
  the one rule; `RecapPlayer` takes `counterparts` and builds the slides via
  the fitting side (length stays, indices stay), `RecapsView` loads the
  opposite sides in the same details batch; `PhotoFeedCard` shows the fitting
  side with its aspect ratio, likes and fullscreen still belong to the
  entry. iOS: `SlideshowVariants.pickSide`, `RecapPlayerView` substitutes per
  orientation before pairing (like the slideshow), `FeedCardView` loads the
  file of the fitting side (`FeedPhotoItem.shownFilename(for:)`). Stories:
  `RecapPlayer` format pair in both orientations. Tests: backend
  (`counterpartsByPhotoId`), web (`pickSideForScreen`), iOS (decoding,
  side selection).
- The album-bound list runs via `/gallery/grid`
  with `albumScopeId` and is thus covered, the anonymous link view has
  no user (and thus no groups) and is left out. The slideshow
  on the web runs via the same `cursorPhoto`, so the rotation switch applies
  there too; a separate side selection per step in `utils/slideshow.ts` is
  only needed once the list holds both sides.

## Problem

Of the same subject there is often a portrait and a landscape shot, taken a few seconds
apart. Both are wanted (the AI pick deliberately keeps both through
orientation diversity), but in every view they sit
next to each other, and on a rotated screen one of the two always fits
badly: in portrait fullscreen only a strip remains of the landscape shot, in the
landscape slideshow only a column remains of the portrait shot.

## Idea in one sentence

> Photos that show the same subject in both formats form a
> **format group**. Each view shows only the side that matches the current
> screen orientation; the other side is one tap (or one
> rotation of the device) away.

The format group is a **view**, not a hiding: nothing is written to
`photo_curation`, counters stay honest, and as soon as the user
selects or deletes, everything is visible.

## Data model

### Where the format group comes from

Cluster nothing new. The similarity groups (`photo_groups`, DINOv2 ≥ 0.90
within the 10-minute window, per user) already provide "same subject". A
format group is the subset of a similarity group that

- has at least one `portrait` and one `landscape` member
  (`classifyOrientation` from `photo/group-auto-pick.ts`, `square` never counts),
- whose members are visible to this user (not `hidden`),
- and where the two formats are at most `VARIANT_TIME_WINDOW` apart (proposal
  120 s). The narrower window separates "two formats of the same shot"
  from "I was at the same place for ten minutes".

Because `photo_groups` are per user and visibility is per user, the
format group is automatically per user. Photos without `width`/`height` (backfill
„Bildmaße nachtragen" (backfill image dimensions) missing) never form a format group.

Reviewed and unreviewed groups behave differently:

| Group | today | with format group |
|---|---|---|
| unreviewed | stack, only the cover visible | stack stays; the member that matches the orientation is shown as cover (fallback: previous cover) |
| reviewed, both formats kept | all kept photos next to each other | only the side of the current orientation; the other side behind a format badge |
| reviewed, one format kept | one photo | unchanged |

### Persistence

No new table. Two additions:

| Column | Table | Meaning |
|---|---|---|
| `orientation_variants` | `photo_groups` | `'auto'` (default, computed), `'off'` (user: "not the same subject", format group never applies), NULL = not checked |
| `collapse_orientation_variants` | `users` | global toggle, default `TRUE` |

The membership itself is computed on read (orientation, visibility
and time window are all already in the query of `listPhotoGroupsLogic`
resp. `/gallery/grid`). Materializing would only be needed if reading becomes
too expensive; the number of groups with both formats is small.

### API

- `GalleryGridEntry` and `Photo` get `orientation: 'portrait'|'landscape'|'square'|null`.
- `GalleryGridGroup` gets `variants?: { portrait: number; landscape: number }`.
- `/gallery/grid` (and the album-/link-bound lists) learn the filter
  `variantMode=all|portrait|landscape`. For `portrait` the server omits the
  landscape shots of each format group and vice versa; `all` shows everything. The
  filter lives in `photo/photo.filters.ts` next to `hiddenMode`. Server-side
  because the grid is server-paginated and a client filter would tear gaps
  into offsets and counters.
- `PATCH /photos/groups/:id/variants` with `{ mode: 'auto' | 'off' }`.
- `ReviewQueueGroup` gets `orientation_pair: boolean`, and
  `ReviewQueuePhoto.width/height` are finally declared in the frontend type.

## Behavior in the views

On the web the screen orientation comes from `useMediaQuery('(orientation: portrait)')`
(`composables/useBreakpoint.ts`), in iOS from `GeometryReader` as in
`PhotoCompareView.swift`. Both apps hold it in **one** composable or
environment value (`useScreenOrientation` / `@Environment(\.screenOrientation)`),
not anew in each view.

### Grid (all photos, album, shared album, iOS grid)

- The list loads with `variantMode=<current orientation>`. When the
  screen rotates, it reloads and keeps the scroll position via the
  `listAnchor` (issue #1279), which already exists.
- The shown photo carries a small format badge (icon "rotate", tooltip
  „Auch im Querformat vorhanden" (also available in landscape)). It sits next to the stack badge, in the same
  corner and size (`.vg-stack-badge` in `VirtualGallery.vue`). A tap on the
  badge opens fullscreen directly with the **other** side.
- In **selection mode** `variantMode=all`: anyone who selects, deletes or puts into the
  basket sees everything. No action affects something invisible.
- The „hidden photos" filter gets the option **„Formatvarianten"** (format variants)
  (analogous to "adopted"), so one can see at any time what is
  collapsed.

### Fullscreen (web `FullscreenOverlay`, iOS `PhotoFullscreenView`)

- The viewer knows the opposite side of every photo. A button „Querformat" /
  „Hochformat" (icon rotate, keyboard `R`) switches to the opposite side in place,
  the index in the list stays.
- **Rotating the device switches automatically** to the fitting side, with a
  crossfade. This is the visible promise of the feature: you rotate the
  phone, and the picture is suddenly the one shot in portrait. Anyone who has just
  deliberately chosen the opposite side is not overruled on rotating (a
  manual switch sets a `pinned` flag until the next photo).
- Paging skips the opposite side (it is part of the current photo, not a
  step of its own). The detail sidebar shows both file names.

### Slideshow

- Web: `utils/slideshow.ts` picks the fitting side per step; on
  rotation in the middle of the slideshow the current picture switches immediately.
- iOS: `SlideshowPlanner` today pairs two landscape shots on the portrait
  screen. With format groups the first rule is: take the fitting side,
  and only then pair what is left. The orientation of the photo then comes
  from the API instead of the decoded image size.

### Recaps and stream

The recap player and feed card show one photo large; they use the same
helper function "fitting side for orientation" and are thus covered too.
No logic of their own, just a stage later.

## Group review

The review is the place where the format group is **confirmed**: anyone who
finishes reviewing a group and keeps both formats has said "this is one subject in
two formats". Hence three changes:

1. **Do not let them compete against each other.** Comparing portrait against
   landscape is the wrong question. In `PhotoCompareView` (web) the photos
   *within* an orientation duel first; in the final grid
   the winners of both formats appear as a connected pair with the note
   „bleiben als Formatpaar erhalten". iOS `CompareTournament.suggestedKeepIds`
   already does this for the preselection, but not yet the duel order.
2. **One action „Bestes je Format behalten".** In the review queue (web card
   and iOS swipe) next to „KI-Pick übernehmen" (adopt AI pick): keeps the best-rated photo per orientation
   and marks it reviewed. For groups with exactly one photo per
   format it is the same as "keep all", only with the statement "format pair".
   As an iOS swipe gesture, *down* suggests itself (right, left, up are taken).
3. **One action „Nicht dasselbe Motiv".** In the review and in the sidebar
   of the group: sets `orientation_variants='off'`. From then on both photos are
   shown next to each other everywhere. Conversely, „Als Formatpaar behandeln" restores
   `auto`. No dialog, both immediately undoable.

The review queue gets a filter chip **„Formatpaare"** and shows the tag
„Hoch + Quer" on the card. KI auto-pick stays as it is: the
orientation diversity does exactly the right thing, and the new state
merely makes visible why the AI kept two photos.

Adopting others' reviews (`documentation/group-review-adoption.md`) does **not**
carry over `orientation_variants`: whether two images are the same subject is
objective enough that `auto` applies to everyone; an `off` is a personal
decision on one's own group.

## What deliberately does not happen

- No writing to `photo_curation`. The opposite side is not "hidden",
  it simply isn't its turn right now. All ~20 query sites that evaluate
  `hidden` remain untouched.
- No counter correction: "120 photos" stays 120, even if the grid shows 110
  tiles. The badge explains the difference on the spot.
- No format group across group boundaries and no clustering run of its own.
- The toggle `collapse_orientation_variants` lives under Photos ›
  Settings; anyone who does not want the behavior has everything as today.

## Stages

1. **Backend**: `orientation` in `Photo`/`GalleryGridEntry`, format group in
   `listPhotoGroupsLogic`, `variantMode` filter, cover selection by orientation,
   `orientation_variants` column + endpoint, user toggle, tests for
   time window, visibility and `off`.
2. **Web grid + fullscreen**: `useScreenOrientation`, reload on rotation with
   anchor, format badge, opposite side in `FullscreenOverlay` (button, `R`,
   auto-switch on rotation, `pinned`), filter option, selection mode = `all`,
   Storybook stories for badge and overlay in both orientations
   (`testViewport`).
3. **Web review**: duels within the orientation, format pair in the
   final grid, „Bestes je Format behalten", „Nicht dasselbe Motiv",
   chip „Formatpaare".
4. **iOS grid, fullscreen, slideshow**: environment value for orientation,
   badge, opposite side in `PhotoFullscreenView`, `SlideshowPlanner` takes the
   fitting side before pairing.
5. **iOS review**: swipe gesture „Bestes je Format", context menu „Nicht dasselbe
   Motiv", duel order in `CompareTournament`.
6. **Recaps and stream** with the same helper function.

## Decisions

The three initially open questions were decided with the user:

- **Time window 120 s** between the two formats, as constant
  `VARIANT_TIME_WINDOW_MS` next to `TIME_WINDOW_MS`. The full group window
  of ten minutes does not apply.
- **Show a side, do not pair.** If the user kept several photos per format
  (3 portrait, 2 landscape), the view shows all photos of the fitting
  side; the other side lies collected behind it. No 1:1 assignment.
- **Rotating switches automatically** in fullscreen and in the slideshow, with a
  crossfade. A manual switch sets `pinned` until the next photo
  and is not overruled by rotating.

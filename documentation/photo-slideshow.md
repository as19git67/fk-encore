# Photo Slideshow (Fullscreen) – Feature Documentation

The slideshow is part of the shared `FullscreenOverlay` component and is
therefore available everywhere the fullscreen view is opened with a configured
interval. It is controlled **manually via the play/pause button** and never
starts on its own.

## Where the Slideshow Exists

A slideshow exists exactly when the `FullscreenOverlay` is embedded with
`autoAdvanceMs > 0`:

| View | Embedding | Slideshow |
|---|---|---|
| Album grid view (`AlbumDetailView`) | `:autoAdvanceMs="10000"` | ✅ |
| Album map view (`AlbumDetailView`) | `:autoAdvanceMs="10000"` | ✅ |
| Shared album (`SharedAlbumView`) | `:autoAdvanceMs="10000"` | ✅ |
| `GalleryView`, `PersonsView` | no `autoAdvanceMs` | – |

## Play/Pause Control

- **No auto-start:** The internal `playing` flag is `false` by default. The
  auto-advance only runs as long as the user has started it.
- **Toolbar button:** In the overlay's action bar (outside the
  `actions` slot, so slot overrides cannot displace it). Visible as soon as
  `autoAdvanceMs > 0`.
- **Keyboard:** `S` starts/pauses the slideshow (everywhere it is available;
  not while typing in input fields).
- **Icon = click action:** The icon always shows what the click triggers – ▶
  (`pi-play`) when stopped, ⏸ (`pi-pause`) while it is running. Every real
  stop sets `playing = false`, so the icon is always correct.
- **Adjustable interval (per user):** Choice between
  **3 / 5 / 10 / 15 / 20 / 30 s** (default **5 s**). Operation depends on
  the input method:
  - **Desktop / mouse (hover-capable):** a pure caret dropdown (`Select`, arrow
    only) next to the play button. The chosen value is not shown inline,
    but appears in the tooltip or in the opened menu.
  - **Touch / mobile (`(hover: none), (pointer: coarse)`):** the caret is
    omitted; instead, a **long press (~450 ms) on the play button** opens a
    popup menu (`Menu`) with the time options (current value with a check
    mark). A short tap starts/pauses as usual; the long press that was
    triggered is "swallowed" by the subsequent click so it does not
    additionally toggle. Since the gesture is invisible, a one-time hint
    ("Play lange drücken, um das Diashow-Intervall zu wählen" — press and hold
    play to choose the slideshow interval) appears **the first time** as a
    speech bubble above the action bar; it disappears after 5 s, on tap, or as
    soon as the play button is pressed. The "seen" flag is stored in
    `localStorage` (`slideshow_longpress_hint_seen`).

  The value is stored **per browser** in `localStorage`
  (`slideshow_interval_ms`); logic in `frontend/src/utils/slideshowInterval.ts`.
  The `autoAdvanceMs` prop only switches the slideshow **on** (value > 0) and
  serves as the fallback default.
- **Interval & idle reset:** While running, it advances to the next photo
  every (configured) number of seconds. Every interaction
  (pointer/keyboard/wheel) resets the interval, so it only advances after a
  short period of rest. Between two photos, it waits until the next image has
  loaded (`playing` stays `true` meanwhile).
- **Details flyout does not pause:** With the detail view open, the
  slideshow keeps running (the description is shown in the sidebar there
  anyway).
- **Stops (icon → ▶):** last photo reached (no wrap-around), opening the
  transform editor (edit), and closing the fullscreen view.

The pure decision logic is extracted into `frontend/src/utils/slideshow.ts`
(`shouldArmSlideshow`, `slideshowReachedEnd`) and unit-tested; the
component owns only the timer and the `playing` state and sets
`playing = false` on real stops (end of list, opening the editor).

## Running Through Without a Day/Stop Boundary (Map View)

When opening the fullscreen view from the map, `TripMap` passes **all trip
photos** in chronological timeline order (days ascending, stops by time,
photos by time – computed `allStopPhotos`), with the start index on the
tapped photo. As a result, paging and the slideshow run continuously across
all days and stops. On closing, the selected map stop is synchronized to the
last photo shown (`closeMapFullscreen` → `selectStopByPhotoId`).

## Date Banner on Day Change

So that a day change during continuous playback is recognizable, the overlay
fades in a subtle date label as soon as the navigation moves into a new day:

- Opt-in via the `markDayChanges` prop.
- Day-change detection via the **local** date key
  (`toLocalIsoDate`, avoids UTC shift) of the new vs. the last shown
  photo; only a **change** is announced, never the start photo (`isDayChange`).
- The label (e.g. "Mittwoch, 14. Januar 2026", i.e. Wednesday, 14 January
  2026) slides in centered below the top bar, stays for ~2.5 s, and slides
  out again – **without pausing** playback. It is
  `pointer-events: none`, so it does not block taps.
- Active in the album map view (always) and in the shared album only if the
  fullscreen view was opened from the map (`fullscreenFromMap`), not in the
  grid.

## Description Caption

While the slideshow is running, the photo description
(`photo.description`) is shown – **if present** – centered at the top above
the image:

- **Single line**, truncated with `text-overflow: ellipsis` (`white-space:
  nowrap`); the full text is in the `title` tooltip.
- **Legibility** via a subtly translucent, slightly blurred background
  (`rgba(0,0,0,0.6)`), independent of the image colors.
- Shown only when the slideshow is running, no details split is open, and a
  non-empty description exists (`shouldShowCaption`).
- Caption and date banner share a centered top stack
  (`.fs-top-overlays`), so they never overlap; both are
  `pointer-events: none`.

The description is available in the slideshow photos: the grid path
hydrates the current photo via `getPhotoDetailsBatch`, and the
album/map photos (`getAlbumLogic`) deliver `description` directly.

## iOS (`ios/`, issue #767 stage 2)

On iOS, the slideshow is **not a mode of the fullscreen viewer**, but a
separate fullscreen player (`PhotoSlideshowView`) — the same story player the
recaps already use (`RecapPlayerView`). The viewer itself no longer plays
anything; its play button hands the photos over to the player.

The player shows only the image:

- **Story progress bar** at the top, one segment per photo — beyond a
  certain number of photos a continuous bar, see below.
- **Tap left** = one image back, **tap right** = forward.
- **Long press** pauses as long as the finger is down.
- **Swipe down** or ✕ closes.
- **Ken Burns motion** per image plus crossfade between slides.
- **Waiting for the loaded image:** As long as a photo of the current slide
  is still loading, progress stands still — the display duration is viewing
  time, not loading time. A **failed** load attempt counts as loaded, otherwise
  a single broken image would stop the slideshow permanently.
- **Interval 3 / 5 / 10 / 15 / 20 / 30 s**, default 5 s, stored per device
  (`UserDefaults` key `slideshow_interval_seconds`; the web uses
  `localStorage` — both are deliberately independent, there is no server
  sync). A stored value outside the options falls back to the default.
  It is changed via the timer menu in the player's header.
  Recaps keep their fixed pacing of 4 s.
- **Background music** as in the recap (speaker button mutes,
  ⏩ switches the track) — see below.
- **Description caption** at the bottom, two lines, only for a non-empty
  description. For a photo pair, the first available description wins.
- **Heart button** marks what is shown as a favorite — for a pair both
  photos, because the tap refers to what is on the screen.
- **No wrap-around:** After the last photo, the player ends and closes.

### Where the Photos Come From

| Entry point | Scope |
|---|---|
| Overflow menu "Diashow" (slideshow) in `AlbumDetailView` | all displayed album photos |
| Play button in the selection toolbar (album, media library, month, filtered timeline) | the selected photos |
| Play button in the toolbar without a selection | everything the view currently shows |
| Play button in the bottom bar of `PhotoFullscreenView` | from the photo shown to the end |

The entry point is visible/active everywhere from **two** photos on — for a
single one there is nothing to advance to.

### Two Images per Slide (Also in the Recap)

A landscape photo on a phone held upright fills only a band in the middle.
Therefore the player stacks **two landscape photos on top of each other** on
one slide when the device is in portrait, and puts **two portrait photos side
by side** when it is held in landscape. The two halves slide in from opposite
edges; single images still crossfade.
Nearly square photos (±5 %) are never paired, because a pair wastes just as
much area there as a single image.

The orientation is only known once an image has been decoded. The plan is
therefore built **incrementally** (`SlideshowPlanner.extend`): it fixes as
many slides as it can decide and waits at the first photo whose partner is
still missing. Slides that have already been shown are never renumbered. If
the player waits longer than 2 s for an image, it gives up **on that one
photo** and shows it on its own — the rest is then planned normally again. If
the user rotates the device, the part already played stays as is and only the
rest is regrouped.

The progress bar therefore has one segment per **photo**, not per slide:
this way it keeps its shape while the plan is still growing; the two segments
of a pair fill together.

### Progress Bar With Many Photos

A recap has a handful of images, but a slideshow over a whole album quickly
has several hundred. One segment per photo does not scale that far:
the segments become invisible hairlines, and worse, the gaps between them
alone become wider than the screen. An `HStack` that does not fit does not
shrink — it makes its parent wider. As a result, the player's `ZStack` grew
with it, and the photo inside was pushed aside: with 247 photos on a 402 pt
wide device, the bar needed 984 pt for gaps alone, and only a 99 pt narrow
strip of the image was left at the right edge.

`SlideshowProgressTrack` therefore first checks whether the segments fit at
all (at least 6 pt per segment plus 4 pt gap). If they do not,
the bar becomes **one** continuous bar showing the overall progress
in photos (`SlideshowPlayback.overallFraction`) — a pair advances it
twice as far as a single image, photos not yet planned count as
pending. In addition, the player's `ZStack` is pinned to the
screen size so that no overlay can ever shift the image again.

### Why the Interval Selection Is Not a `Menu`

The ticker writes to `playback` twenty times per second, and every write
rebuilds the view. A `Menu` that is opened from such a rapidly changing view
loses the taps on its own rows — the selection fell through. A `Menu` also
has no "is open" state that a pause could be tied to.

The selection therefore now belongs to this view (`isChoosingInterval` +
`confirmationDialog`), and `isSuspended` halts ticker **and** music while it
is open — just like with the long press. The current interval is marked with
a ✓ in the text, because an action sheet row has no selection state of its
own.

### Chrome and the Camera Cutout

The photo is deliberately edge-to-edge: the player's content ignores the safe
area so the image reaches every edge. The controls must **not** follow it
there — with a 12 pt distance from the *screen edge*, the progress bar and
album name sat under the Dynamic Island in portrait.
`SlideshowChromeInsets` therefore places them back inside the safe area: top,
bottom (home indicator) and, in landscape, also on the sides, each plus the
player's own margin of 12 pt. The bottom value comes without this margin,
because the callers there already bring larger spacing (caption 92 pt).

**Important:** `.ignoresSafeArea()` must be applied to the *content* of the
`GeometryReader`, not to the reader itself. Attached to the reader, it
reports `safeAreaInsets` of **zero** from that point on — it was already
extended to full screen before its closure runs, so from its own point of
view it has nothing left to offset from. That is exactly what happened on the
first attempt: `chrome` existed but was always computed with zero insets, so
the chrome still ended up at exactly the old, broken position under the
island — a bug that only shows on a device, violates no unit-test assertion,
and comes down purely to the order of the modifiers.

### Music

Both players use the same class `SlideshowMusic` (tracks from
`GET /recaps-music`, streamed via the `APIClient`, endless loop, fade-in
over 1.5 s, volume 0.55). Errors stay silent — an error UI is never worth it
for music.

Difference between the two:

| | Recap | Slideshow |
| --- | --- | --- |
| Track suggestion | from the server (`GET /recaps/:id`, field `music`) | none — there is no album "mood" |
| Starting point | the suggested track, the cycle returns to it | the last chosen track, otherwise the first of the list |
| Muting | per playback | remembered per device (`slideshow_music_muted`) |

A slideshow is started far more casually than a recap, so it remembers
both decisions (`slideshow_music_muted`, `slideshow_music_track`): whoever
mutes once gets peace and quiet the next time as well.

### Ken Burns and Faces

The Ken Burns motion is derived deterministically per photo from the photo ID
(same hash as on the web), so an image always drifts the same way. The face
relation has two levels:

1. **Image crop:** If a server-side focus point exists (`auto_crop`,
   face center, normalized 0..1), the fill crop is shifted there —
   limited by the overhang, analogous to CSS `object-position`. Without a
   focus point, it stays at the geometric center.
2. **Motion target:** The **zoomed-in** end of the move lies exactly on
   this focus point (offset 0), only the wide end wanders randomly. The
   motion thus always runs toward the face (or away from it) instead of
   drifting aimlessly. Photos without a focus point keep the purely random
   motion at both ends.

`auto_crop` is set server-side and is not present for every photo;
without a value, the motion behaves as before.

### Deliberately Different From the Web

- The web player is a mode of the `FullscreenOverlay` with a play/pause
  button; on iOS it is a separate view. Accordingly, there is no
  play/pause icon there, but pause by finger press.
- **Photo pairs and the face relation of the Ken Burns motion exist so far
  only on iOS.**
- **No date banner and no idle reset.** On the web, both hang on the
  map/trip view or on pointer/wheel events; on iOS there is no
  corresponding entry point for them so far.

## Affected Files

| File | Role |
|---|---|
| `frontend/src/components/FullscreenOverlay.vue` | Play/pause button, auto-advance timer, date banner, description caption, `markDayChanges` prop |
| `frontend/src/utils/slideshow.ts` | Pure logic: `shouldArmSlideshow`, `slideshowReachedEnd`, `isDayChange`, `shouldShowCaption` |
| `frontend/src/utils/slideshow.test.ts` | Unit tests of the logic |
| `frontend/src/components/TripMap.vue` | `allStopPhotos`: whole trip as fullscreen scope (`open-fullscreen`) |
| `frontend/src/views/AlbumDetailView.vue` | Map overlay: `:markDayChanges="true"`, stop sync on close |
| `frontend/src/views/SharedAlbumView.vue` | Overlay: `:markDayChanges="fullscreenFromMap"` |
| `ios/Sources/FKPhotos/Features/Photos/PhotoSlideshowView.swift` | iOS: story player over album/selection/media library |
| `ios/Sources/FKPhotos/Features/Recaps/RecapPlayerView.swift` | iOS: the same player for recaps (plus music/intros) |
| `ios/Sources/FKPhotos/Features/Photos/SlideshowPlan.swift` | iOS: pure logic — orientation, pair planning, playback position |
| `ios/Sources/FKPhotos/Features/Photos/SlideshowStage.swift` | iOS: rendering of a slide (single/pair), Ken Burns motion, progress bar |
| `ios/Sources/FKPhotos/Features/Photos/SlideshowImageStore.swift` | iOS: image preloading + orientation after decoding |
| `ios/Sources/FKPhotos/Features/Photos/Slideshow.swift` | iOS: interval/music persistence + caption rule |
| `ios/Sources/FKPhotos/Features/Photos/SlideshowMusic.swift` | iOS: background music, shared by slideshow and recap |
| `ios/Sources/FKPhotos/Features/Albums/AlbumDetailView.swift` | iOS: menu item "Diashow" and selection slideshow |
| `ios/Tests/FKPhotosTests/SlideshowPlanTests.swift` | iOS: unit tests for planning, playback and Ken Burns |
| `ios/Tests/FKPhotosTests/SlideshowTests.swift` | iOS: unit tests for interval and caption |

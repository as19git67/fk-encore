# iOS Trip Mode – Feature Plan

As of: 2026-07-24 · Status: Draft (decisions 1–4 locked)

## 1. Goal & Core Idea

A toggle "Trip Mode". When it is on, new photos taken on the iPhone are
automatically synchronized into an fk-encore album — **without** an album
having to be created beforehand (neither in iOS nor in fk-encore). The app
creates an iOS album automatically, fills it with the new trip photos and
syncs it. For group trips, a shared album can easily be used.

**Key insight:** ~80 % already exists. Trip Mode is an orchestration layer
on top of the album sync machinery
(`makeAvailable` → `albumMappings` / `albumSyncModes` / watermark upload /
bisync download / `albumShares` / push). Only one mechanism is truly **new**:
automatically *putting* new photos into an iOS album (today the user curates
that by hand in Photos.app).

## 2. Locked Decisions

1. **Default mode solo = `sync`** (not bisync). Reason: `sync` also propagates
   culling on the iPhone (photo removed from the album) to the server album.
   bisync can optionally be switched on.
2. **Trip membership = time window** as the default, **home exclusion zone**
   as a refinement. Explicitly *no* zone around the starting location: a trip
   moves away from the start, and the distance to the starting location says
   nothing about whether a photo belongs.
3. **Shared trip = `sync` as the default**, switchable to bisync per user.
   The server album is the common basis.
4. **Automatic trip detection**: desired (as a suggestion) if it works
   reasonably reliably → its own stage.

## 3. Reuse vs. New

| Building block | Status |
|---|---|
| iOS↔server album link, setting the mode | exists (`LibraryBrowserViewModel.makeAvailable`) |
| Upload of new photos, watermark, dedup | exists (`PhotoSyncService`) |
| Culling → server removal (`sync`) | exists (`syncAlbumDeletions`) |
| Server photos to the device (bisync) | exists (`PhotoDownloadService`) |
| Share album, find participants | exists (`/albums/share`, `/albums/:id/shareable-users`) |
| Push/notifications | exists (sharedalbum service) |
| Trip detection (home centroid, time/geo cluster) | exists for recaps (`recaps.service.ts`) |
| **Automatically put new photos into the iOS album** | **NEW** |
| **Trip metadata (start/end/active) on the server** | **NEW (minimal)** |

## 4. Capture Window Mechanics (Core)

A trip is a time window `[start, end?]` (+ optional geofence
lat/lon/radius). The auto-add pass runs wherever sync already runs
(foreground resume, cold start, BG task) and additionally reactively via
`PHPhotoLibraryChangeObserver`:

> For every image asset with `creationDate ≥ start` (and, if a geofence is set,
> within the radius) **that has never been handled**, → put it into the trip
> iOS album and mark it as handled.

**Culling reconciliation (critical because of decision 1):** Auto-add must
never take "all window assets that are not in the album" — otherwise a photo
that was just culled would be re-inserted immediately, and `sync` mode would
get into an add/remove conflict including a re-upload. Instead, a
**`handledAssetIds`** (or a high-water mark on `creationDate` + edge list),
exactly analogous to the upload watermark: only never-handled assets are
added. If the user then removes a photo from the album, it stays removed and
`sync` deletes it server-side.

- **Auto mode:** handled = automatically added.
- **Manual mode:** handled = added **or** discarded (`dismissed`).
  Candidates for the review grid = window assets − handled.

Robust against app kills: the pass catches up on the next run (idempotent),
which fits the resilience work on `runFullSync`.

**Why the reconciliation is needed at all (and does not occur today):** The
current implementation has **exactly one writer** of album membership
— the user (in Photos.app). The sync only *reads* membership and derives
upload/deletion from it; it *never adds* anything. If the user removes a photo,
`sync` propagates that to the server and nothing ever re-inserts it → no
conflict. With the auto-add pass, Trip Mode introduces a **second, automatic
writer** — only then can "culled → immediately re-inserted → re-upload → …"
arise. `handledAssetIds` (touch every asset exactly once) restores the "one
effective writer" property. Precedent: the bisync download side already
inserts photos into the iOS album today (downloaded server photos) and
tracks what it added via `downloadedPhotos` / `forgetDownloadedPhotos`, exactly
to avoid the same fight with culling. `handledAssetIds` is the upload-side
counterpart.

## 5. Trip Lifecycle

- **Start:** the time of switching on (deterministic, no false alarms).
- **Place/name:** fetch the current `CLLocation` at the start, reverse-geocode
  (geo/osm-admin) → name suggestion "Gardasee (Juli 2026)" (Lake Garda
  (July 2026)), editable. The name becomes the server album name.
- **Home exclusion zone (optional):** home centroid (`GET /trips/home-location`,
  same source as the auto-end) + `homeArrivalRadiusMeters`; narrows
  membership (photos taken at home during a running trip drop out). Without a
  known home location, the pure time window applies.
- **End:** toggle-off (default). Later optionally auto-end (again longer in
  the home region) + max duration.
- **Toggle-off:** auto-add stops for *new* photos. iOS album, server album,
  link remain — the trip becomes a normal linked album, mode still
  changeable (existing disconnect/mode logic).
- **Follow-up after the end (important):** On ending, the trip is **not
  discarded**, but moved with `endedAt` set into a list of ended trips
  (`TripPreferences.loadClosedTrips`). Reason: the auto-add pass only sees the
  photo library while the app is running — photos taken with the camera app are
  regularly discovered only later, possibly only after the toggle-off. The
  catch-up still processes such photos. `endedAt` is the **hard upper bound**:
  photos created after the end never land in the trip album. After a grace
  period (`TripMembership.closedTripGrace`, 24 h), the ended trip drops out of
  the list.

## 6. Solo Trip – Flow

1. Toggle on → app creates the iOS album, calls the `makeAvailable` logic
   (find/create server album by name matching), mode **sync**, confirm,
   `syncEnabled = true`, watermark = now.
2. The auto-add pass puts new photos into the album, sync uploads.
3. The user culls on the iPhone → `syncAlbumDeletions` removes them from the
   server album (own uploads only, safe).
4. Toggle off → freeze.

## 7. Manual Curation Mode (Option 5/6)

**What the Auto/Manual switch decides – and what it does not.** The switch
only concerns the path of new photos *into the iOS album*:

- **Automatic** (`autoAdd = true`): Newly taken photos are put into the iOS
  trip album by the auto-add pass. The synchronization into the f4mil album
  thus takes effect.
- **Manual** (`autoAdd = false`): Newly taken photos stay in the Recents
  view. The user puts into the iOS trip album, in the Photos app, whatever
  should belong.

In **both** cases the iOS trip album is synchronized to f4mil –
even if it stays empty in manual mode as long as nobody has put anything in.
"Manual" is therefore not "off": sync mode (copy/sync/bisync) and album stay
active unchanged. The app says so in the line below the switch and in the
empty state of the photo grid.

Switch `autoAdd = false` in the trip. Next to the trip toggle a button →
review view: grid of all new, not yet handled trip candidates (window rule).
Multi-select → "Zum Trip-Album hinzufügen" (add to trip album)
(+ optionally "Jetzt synchronisieren" (sync now)). Unselected ones can be
dismissed (`dismissedAssetIds`) and do not reappear.

## 8. Shared Trip

A shared trip = **one shared server album with a coordinated lifecycle**, not
a new sharing concept. Each member has their own iOS trip album, which syncs
via **sync** into the shared server album.

**Deletion safety fits perfectly:** `syncAlbumDeletions` only touches photos
that *this device* uploaded (`serverPhotoMap`). A can therefore only cull A's
own photos from the shared album, never B's. Exactly right.

- **Invite (implemented, issue #918):** The "Teilen" (share) button in the
  active trip view opens the regular `AlbumShareView` for the trip server
  album: invite participants from `/albums/:id/shareable-users` with `read` /
  `write` / `write_share` or create a public link. The trip-specific push
  ("Anna hat dich zum Trip 'Gardasee' eingeladen" — Anna invited you to the
  trip 'Gardasee') and the recipient provisioning still follow in stage 3.
- **Join on switch-on:** The client asks `GET /trips/active` (active trips
  from my circle) → dialog "An Trip von Anna teilnehmen?" (join Anna's trip?).
  On acceptance, provisioning maps the local iOS album **directly to the known
  server album ID** (not via name matching!), mode sync.
- **bisync optional:** Whoever wants everyone else's photos on the device
  switches to bisync per trip (storage notice).

## 9. Automatic Trip Detection (Suggestion, Stage 5)

Home-distance heuristic borrowed from the recaps (`computeHomeCentroid`): if the
user is > X km from the home centroid for > Y hours → proactive suggestion
"Sieht aus, als wärst du unterwegs (Ort). Trip Mode einschalten?" (Looks like
you're on the road (place). Turn on Trip Mode?). Deliberately only a
suggestion, never automatic (reliability/battery).

**Status: both directions are implemented** — §9.1 (end), §9.2 (start) and the
brakes from §9.3.

### 9.1 Auto-End Suggestion (Implemented)

The mirror-image half — "longer in the home region again → end the trip?"
— **is implemented**, independent of the (still open) start suggestion:

- **Server:** `GET /trips/home-location` (`photo/trips.ts`) returns the user's
  home centroid, computed with the same `computeHomeCentroid` function as the
  recaps — client and server thus agree on where "home" is. `null` as long as
  too little geodata is available.
- **Client:** `TripAutoEndMonitor` (singleton, `@MainActor`) starts on
  `TripStore.startTrip` and stops on `endTrip`. Registers
  `CLLocationManager.startMonitoringSignificantLocationChanges()` — also runs
  while the app is in the background or (with "Always" permission)
  terminated; the system wakes the app as needed to deliver the update.
  `NSLocationAlwaysAndWhenInUseUsageDescription` in `Info.plist` justifies
  the additional permission request.
- **Heuristic (`TripAutoEndHeuristic`, pure/testable):** If the device stays
  continuously within `homeArrivalRadiusMeters` (2 km — tighter than
  a typical trip geofence of 25 km, so that a trip near home does not
  immediately appear "ended") for at least `homeArrivalGrace` (2 h),
  the suggestion is triggered. If the device leaves the radius in between,
  the clock starts over. After a suggestion, `suggestionCooldown` (6 h)
  applies, so that a short shopping trip near home does not ask again
  immediately.
- **The suggestion reaches the user in two ways, both fed from `pendingSuggestion`
  (`TripAutoEndPreferences`):**
  1. Local notification with actions "Trip beenden" (end trip) / "Weiter
     unterwegs" (still on the road) — answerable directly from the lock-screen
     notification without opening the app
     (`AppDelegate.userNotificationCenter(_:didReceive:)`).
  2. Banner at the top of `TripView`, if the notification is not allowed,
     missed or ignored — appears on the next opening/
     foreground switch of the app.
  Both ways end the trip only after explicit confirmation; tapping the
  notification without an action or "Weiter unterwegs" only clears the
  suggestion (the cooldown still applies, so it does not ask again
  immediately).
- If location permission is missing or denied, the trip continues
  unchanged — the monitor is a pure add-on on top of the existing manual
  "Beenden" (end) button in `TripView`.

#### 9.1.1 Why the Suggestion Initially Never Arrived (Fixed)

The first version evaluated the heuristic **exclusively in
`didUpdateLocations`**. But iOS delivers significant-change updates only on
*movement* — and "arrived at home" means precisely that the device stays put.
In practice: on arrival exactly one update came (clock starts,
`shouldSuggest == false`), after that the phone lay still, no further update
ever came, and the moment "two hours continuously at home" was never
evaluated. The suggestion could therefore fundamentally not appear.

Aggravating this, `resumeIfTripActive()` called `resetArrivalTracking()` at
the start of **every process**. `isMonitoring` is process-local,
so this happened on every cold start — and the significant-change service
itself restarts the app to deliver updates. The arrival clock was thus reset
by exactly the mechanism whose expiry it was supposed to measure.

Three changes fix this:

1. **Pre-scheduled notification instead of reactive evaluation.** The
   heuristic no longer returns just "suggest now: yes/no", but the
   *point in time* from which asking is allowed (`armFireAt` — the later of
   the expiry of the grace period and the end of the cooldown). On arrival,
   `TripAutoEndMonitor.arm(...)` schedules a
   `UNTimeIntervalNotificationTrigger` notification for it. The system delivers
   it on its own, even if the app never runs again. If the device leaves the
   radius, it is withdrawn via `disarm()`.
2. **Arrival clock survives restarts.** `start(resetTracking:)` only resets
   the state at the *beginning* of a trip; `resumeIfTripActive()`
   passes `false`.
3. **Evaluation even without a location update.** `evaluateNow()` checks the
   last known position and also runs in `runFullSync()` — i.e. on app start,
   foreground switch and background task. This additionally covers the case
   that only "While Using" permission was granted at all.

The notification ID is stable per trip and is used for the scheduled *and* the
immediate variant — the same ID replaces the previous request, so
double-asking is ruled out. The pure decision logic is pinned down in
`TripAutoEndHeuristicTests`.

**Start and end are deliberately not mirror images.** At the start, no trip
is running yet — continuous CoreLocation operation with "Always" permission
cannot be justified here as it can for the (already running, explicitly
started) trip above. The start suggestion instead uses a signal that is
already available for free: the GPS coordinates of new photos from the
auto-add/sync pass.

### 9.2 Start Suggestion (Implemented)

`TripAutoStartMonitor` (singleton, `@Observable @MainActor`).

- **Signal source:** `PHAsset.location` of the photos that the already running
  enumeration pass (`runFullSync`: foreground resume, cold start, BG task; plus
  reactively via `PHPhotoLibraryChangeObserver`) sees anyway — no
  additional CoreLocation monitoring, no new permission. Photos from the last
  `lookback` = 48 h are considered.
- **Heuristic (`TripAutoStartHeuristic`, pure/testable, analogous to
  `TripAutoEndHeuristic`):** Photos with GPS **> 100 km** from the home centroid
  (`TripHomeLocation.resolve()`, same source as §9.1) AND across
  **≥ 2 distinct capture times with a ≥ 6 h span** between first
  and last → suggestion. The time span prevents a single photo
  from an airport layover from triggering immediately; 100 km is considerably
  more than the 2 km home radius from §9.1 and more than a typical day trip.
  - Distance and span are measured **only over the far-away photos** —
    otherwise a single distant photo would inherit the time axis of
    uninvolved photos taken at home.
  - The most recent distant photo must be at most `recencyWindow` = 12 h old,
    otherwise the trip is already over ("drove home this morning").
  - If a trip is already running (or one is just winding down,
    `TripStore.hasPendingTripWork`), no check is done at all — there is only
    one active trip (§14.4).
  - No home centroid known → no check, no suggestion (as everywhere in
    this document: missing geodata is not an error state, see §14.3).
  - After a rejected suggestion, `suggestionCooldown` = **24 h** applies —
    much longer than the 6 h for the end, because starting is the bigger commitment.
- **Signaling — deliberately quieter than for the end (§9.1), because starting has more
  consequences than ending:**
  1. **Local notification** "Sieht aus, als wärst du unterwegs" (Looks like
     you're on the road) with the actions **"Trip starten"** (start trip),
     **"Nicht jetzt"** (not now) and **"Für diesen Ort nicht mehr fragen"**
     (don't ask again for this place) (the latter writes to
     `TripRegionSuppression`, §9.3).
  2. **"Trip starten" opens the prefilled `TripStartSheet`** instead of starting
     the trip directly — unlike at the end (§9.1: "Trip beenden" is
     one-click). The start flow needs the name confirmed by the user
     (§14.3: reverse geocoding → suggestion → confirmation/editability); a
     notification action must not skip that. Technically this runs via
     `shouldPresentStartSheet`: the action can run in a freshly started
     process, long before a view exists that could receive it.
     `TripView` consumes the flag when it appears. The rough location from
     the photo cluster prefills the name suggestion, but does not replace the
     usual reverse geocoding at the actual start.
  3. **Banner in `TripView`** in the "Kein aktiver Trip" (no active trip) state
     (`noTripView`, `TripView.swift`) as a fallback if notifications are
     denied, missed or ignored — analogous to the auto-end banner in
     `ActiveTripView`. In the foreground, therefore, *no* notification is
     posted: the banner already carries it.
  4. **Tab icon badge:** the dot on the trip tab now also appears for an open
     start suggestion (`ContentView`), not only for a running trip. Carries
     on its own if both the notification and the banner were missed.
  Merely tapping the notification without an action only opens the app (the
  prefilled sheet then does not appear automatically) and is not an implicit
  yes — just like at the end (§9.1), only an explicit action clears the
  suggestion; "Nicht jetzt" additionally starts the cooldown.
- **Persistence:** `PendingStartSuggestion` (name suggestion, grid cell,
  `travellingSince`, `raisedAt`) in `TripAutoStartPreferences` — separate from
  `TripAutoEndPreferences`, with its own keys: a rejected start suggestion
  for a region must not influence a later end suggestion and
  vice versa. The monitor additionally mirrors the state as `@Observable`
  in memory, so that banner and badge react to it; UserDefaults is the
  copy that survives a process restart.

**Both notification categories are registered together**
(`TripNotificationCategories.registerAll()`). `setNotificationCategories`
*replaces* the set instead of adding to it — if each category registered
itself, only the last registered one would remain and the other notification
would arrive without action buttons.

### 9.3 Suggestion Permanently Dismissible per Location (Implemented)

Without this, e.g. the daily commute to the workplace would ask "Trip Mode
einschalten?" (turn on Trip Mode?) every day. Three interlocking brakes:

1. **"Für diesen Ort nicht mehr fragen"** as an action on the suggestion
   (notification and banner) → the grid cell lands in `TripRegionSuppression`.
   The cell size is `TripRegionGrid.cellDegrees` = 0.05° — the same value as
   `HOME_CELL_DEG` in `photo/recaps.service.ts`, so that "this place" means the
   same on client and server. *New* travel destinations are still
   suggested, only this place falls silent.
2. **Auto-suppression of frequent places:** cells with
   `autoSuppressAfterDistinctDays` = 5 distinct photo days are effectively
   second homes (work, parents, gym) and never trips — the same
   "distinct days" idea as the home detection, only per region. Counted
   over **all** photos of the pass, not just the far-away ones, and
   independent of whether a suggestion arises: a region qualifies precisely
   through the visits that were never worth asking about. The commute thus
   falls silent on its own over time.
3. **Cooldown & global switch:** 24 h of quiet after every rejection (§9.2);
   additionally, in the sync settings, the switch "Trip-Vorschläge" (trip
   suggestions), which shuts down both directions — including withdrawal of an
   already scheduled end notification. There, the hidden places can also be
   reset ("Ausgeblendete Orte zurücksetzen").

**Why region suppression only affects the start:** The region of the
end suggestion is by definition home. "Don't ask here anymore" would not be a
narrowing there, but a switching off of the feature — and that is what the
global switch is for.

## 10. Server Changes (Minimal)

- `albums`: `is_trip boolean`, `trip_started_at timestamptz null`,
  `trip_ended_at timestamptz null` (owner = `albums.user_id` already exists).
- `GET /trips/active` — trips that I own or that are shared with me and
  that are active (for the join dialog).
- Trip creation: `POST /albums` + flag (or a thin `POST /trips`).
- Invitation: existing `/albums/share` + new notification type "trip_invite".
- Everything else (album/share/sync endpoints) reused unchanged.

## 11. Client State (`TripPreferences`)

`ActiveTrip`: `serverAlbumId`, `iosAlbumId`, `name`, `startedAt`, `endedAt?`,
`geofence?` (lat/lon/radius), `autoAdd` (auto/manual), `mode` (sync/bisync),
`handledAssetIds` / `dismissedAssetIds`, `isShared`, `ownerUserId?`.

For the auto-detection (stage 5): `suggestionsEnabled` (global switch),
`suppressedTripRegions` (set of grid cell keys), `lastSuggestionByRegion`
(cooldown per region).

## 12. Stages

1. **Solo, manually started** (detailed specification §14): trip tab (replaces
   the people tab), auto iOS album + server album (reuse `makeAvailable`),
   capture-window auto-add (change observer + catch-up on sync) including
   `handledAssetIds` reconciliation, **geofence + auto-name** from CoreLocation.
   Mode sync. Exactly **one** active trip. Images only. Toggle-off freezes.
2. **Manual curation mode**: review grid, selection → add → optionally
   sync, `dismissedAssetIds`.
3. **Shared trip – invitation**: `albums` trip columns, invitation via share +
   push, recipient provisioning (direct mapping), mode sync.
4. **Join on switch-on**: `GET /trips/active` + join dialog.
5. **Auto-suggestion**: home-distance detection + auto-end.

## 13. Open Detail Questions (for Later)

- Auto-end heuristic: thresholds (hours in the home region, km).
- "Trip active" on the server: is `trip_ended_at IS NULL` enough, or is a
  visibility window needed for the join dialog (e.g. only trips of the last
  N days)?

## 14. Stage 1 – Detailed Specification

Locked on 2026-07-24.

### 14.1 Navigation / UI Rework

- **Tab bar** (`ContentView.MainTabView`): The **people tab is replaced by
  a trip tab**. Order then: Feed, Albums, **Trip**, Search,
  Settings.
- **People moves into "Alben"** (Albums) as a special entry row — analogous to
  the existing "Alle Fotos" (all photos) (`AllPhotosRef`) and "Gruppen-Review"
  (group review) (`GroupReviewRef`) at the top of `AlbumsListView`. A new row
  "Personen" (people) opens the existing people grid. (A separate, clearly
  delimited sub-task of the UI rework, independent of the trip logic.)
- **The trip tab icon is state-dependent**: different symbol or
  coloring depending on whether a trip is currently active (e.g. accent-colored/filled
  with an active trip, neutral otherwise).

### 14.2 Trip View (Content of the Trip Tab)

- **No active trip:** entry with a "Trip starten" (start trip) action (+ possibly
  a list of past/frozen trips as normal albums).
- **Active trip:** at the top the option buttons (end trip, mode
  copy/sync/bisync, auto/manual, edit name/place), below it the **photo grid**
  of the trip album contents. Below the auto/manual switch, a line that
  says what it does (see §7: only the path into the iOS album, synchronization
  runs in both positions). In manual mode additionally the button to the
  review grid (stage 2).

### 14.3 Start Flow

1. Toggle "Trip starten".
2. Query **CoreLocation** once ("When in use" permission is enough):
   current position → reverse geocoding → **suggest place name immediately**, with
   confirmation + option to edit. The confirmed name becomes the server album name.
3. Stamp the **home exclusion zone** from the home centroid (not from the
   start coordinate!). The starting location serves exclusively the name suggestion.
   The zone is **supplied later** (`TripStore.applyHomeExclusion`), not awaited
   in the start path: a trip often starts without network. Until it is in place,
   the pure time window applies — the safe direction (better to include too much).
4. Create the auto iOS album, `makeAvailable` logic (find/create server album by
   name matching), mode **sync**, confirm, `syncEnabled = true`,
   watermark = now.

### 14.4 Fixed Parameters

- **Exactly one active trip** at a time (no parallel trips in stage 1).
- **Images only**, no videos (as in the existing upload).
- **`handledAssetIds` + high-water mark on `creationDate`** (implemented): the
  watermark (`ActiveTrip.handledWatermark`) is the efficient
  enumeration bound (as in the upload sync), the ID list only the small
  edge set — keeps the state small for large libraries/long trips.
  Details:
  - The watermark means "everything up to here has been **looked at**" — also
    assets that were *not* candidates (already handled or outside the
    geofence). Only this allows the old ID list to be dropped on advancing:
    otherwise an already handled, newer photo could slip below the watermark
    and be re-inserted on the next pass (conflict with culling, §4).
  - The lower bound is **inclusive** (`creationDate >= watermark`), the edge
    list contains exactly the assets on that timestamp. A strict `>`
    would swallow burst shots that share a `creationDate`.
    If the watermark advances, the new edge list replaces the old one; if it
    stays the same, both are merged.
  - The watermark advances **only on a successful add**. If
    `performChanges` fails, it stays put and the assets are retried on the next
    pass.
  - Trips that were stored before the watermark decode it as `nil`
    and start once again at `startedAt`; the first pass condenses the
    accumulated ID list. No migration needed.
  - Known consequence (as with the upload sync): a photo that *subsequently*
    lands in the library with a `creationDate` below the watermark
    (iCloud lag from another device, import) is no longer picked up.
- **Home exclusion membership**: A window asset drops out only if
  it has GPS *and* lies within the home zone. Everything else in the window
  belongs to the trip — regardless of how far from the starting location it was
  taken. Assets **without** GPS: "include" (when in doubt, take it;
  the user can correct in manual mode/when culling).

  > **History (bug):** Until then, this was an *inclusion* zone around the
  > starting location with a 25 km radius. A trip switched on in Munich and
  > photographed in Frankfurt thereby silently lost all its photos. Because the
  > watermark also advances over the rejected assets (see above), the
  > loss was final: the photos lay below the watermark and were never
  > enumerated again. Trips still stored with `geofence` reset
  > their watermark once on loading
  > (`TripPreferences.migratedFromStartGeofence`) and fetch the photos
  > retroactively.

### 14.5 ChangeObserver

- Register `PHPhotoLibraryChangeObserver` while a trip is active; restricted to
  image assets. Reactive auto-add complements the catch-up pass in
  `runFullSync` (foreground/cold start/BG), it does not replace it — the catch-up
  remains the reliable boundary against missed changes on app kills.
- The observer fires **only while the app is running**. Photos taken in the
  camera app while the F4mil app is suspended produce no callback;
  the catch-up in `runFullSync` is the only way for them.

### 14.6 Catch-up Guarantees

- The pass runs in `runFullSync` **before** download/upload and **outside** the
  `pipelineLock`. Inside the lock it was skipped as soon as another
  trigger already held a pipeline (cold-start task and foreground resume
  routinely race each other) — the photos then missed exactly the scan that was
  just running. The pass is local, cheap and idempotent; the lock
  protects only the upload/download pipeline.
- Concurrent triggers are **chained, not discarded**. The former
  `isAutoAdding` guard returned `0` when a pass was running, so a photo taken
  during the pass sat until the next trigger. Now
  every caller gets a pass that starts after its call; a follow-up pass without
  new candidates returns immediately, the chain terminates.
- Ended trips are processed in the same pass (window up to `endedAt`),
  ended ones first. On toggle-off, a pass including sync additionally runs
  immediately, as long as the app is in the foreground anyway.

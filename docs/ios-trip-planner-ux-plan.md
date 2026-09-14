# iOS Trip & Vacation Planner: UX Findings and Improvement Plan

Scope: the "Trip" tab of the iOS app (middle button of the main tab bar) and
everything reachable from it: trip mode (`Features/Trip`) and the vacation
planner (`Features/TripPlanner`). The audit was done by reading the code
(about 19,000 lines of Swift) and cross-checking against
`docs/ios-trip-mode.md` and `docs/ios-urlaubsplanung.md`.

Chapter 1 lists what a user runs into. Chapter 2 proposes how to fix it, in
the same order, referenced by finding ID.

---

## 1. Findings

Finding IDs: **S** = structure, **T** = terminology, **D** = dead ends and
missing feedback, **B** = bugs with UX impact (verified in code), **I** =
inconsistencies, **E** = effort (too many taps), **A** = the add-a-place
paths, **X** = smaller issues.

### 1.1 Structure

**S1 — The planner is an appendix of the photo mode.**
The tab is called "Trip" and shows the photo sync. The whole vacation planner
hangs on a single toolbar icon top right (`Features/Trip/TripView.swift:43`).
The concept (`docs/ios-urlaubsplanung.md` §8.1) describes two peer areas,
"record" and "plan". The navigation from tab to a day screen is four levels
deep behind an icon in a tab about something else.

**S2 — The running plan is hidden as soon as trip mode is on.**
`plannedTripBanner` (`TripView.swift:135-162`) is rendered only inside
`noTripView`. In `ActiveTripView` (name, mode picker, photo grid) there is no
sign that a planned trip is running today and no "open plan" button. The
target state (trip planned, photos syncing) is the one in which the plan is
hardest to reach.

**S3 — One "More" menu with 14 flat entries.**
`TripPlanDayView.swift:72-194`: Vorrat, Ort suchen, Aus dem Vorrat, Etappen,
Wer plant mit, Abendlicht, Änderungen, Abstimmen, Wer fährt mit?, Dokumente,
Reisebereit?, Danach, Unterwegs ohne Netz, Einstellungen. One divider. Day
actions sit next to trip administration. "Reisebereit?" (the evening before)
and "Danach" (after the trip) are hidden exactly when they are needed, and
"Danach" is relevant when the app no longer opens on the trip at all.
Trip-wide screens (documents, journal, review) are reachable only from a day,
never from the plan list.

**S4 — Two different meanings of "active".**
Trip mode on (photo feature) and planned trip running today (date) are
separate states that the app never unifies:

- `TripPlanDayView.swift:1280`: `isTravelling` is `TripStore.shared.isActive`
  only. Standing in the city on the planned day, without trip mode, the user
  gets "show on map" instead of "route here", and "Ab hier umplanen" never
  appears. The correct rule already exists as `TripLaunchRoute.opensOnTrip`.
- `TripView.swift:81-89`: the tab auto-pushes the day screen once per launch.
  Going back, the flag is set, so the same tap leads somewhere else the
  second time.
- `TripView.swift:104-110`: auto-start suggestion and running-plan banner are
  an `if / else if`; when both apply, only the auto-start banner shows and
  the trip name is prefilled from the geocoded location, not from the plan.
- `TripStore.swift:148-167`: after "Beenden" photos keep flowing into the
  album for 24 h (grace period) and any new start suggestion is blocked, but
  the tab says "Kein aktiver Trip" without explanation.

**S5 — Settings live in three unconnected places.**

- Maps app: Settings tab → Profil → "Karten-App" (`Features/Admin/AdminView.swift:68`).
  The "Navigation öffnen mit" dialog in the day screen offers no way to it.
- Trip suggestions and "Ausgeblendete Orte zurücksetzen": Settings →
  Foto-Synchronisierung → section "Trip" (`Features/Sync/SyncSettingsView.swift:119`),
  under a heading about synchronisation.
- Plan settings: day screen → More → Einstellungen, as the only sheet in a
  menu of pushes (`TripPlanDayView.swift:186-192`).
- The home location that decides which photos are excluded and when "Bist du
  zurück?" fires (`Trip/TripHomeLocation.swift`, 2 km radius in
  `TripAutoEndPreferences.swift:26`) is visible nowhere and not adjustable.
  If the server returns `null`, auto-end silently never fires.

### 1.2 Terminology

**T1 — "Vorrat" names two different containers.**
The per-leg candidate pool (`TripPoolView`, menu "Vorrat (n)",
`TripPlanDayView.swift:78`) and the trip-independent idea collection
(`TripIdeasView` "Ideenvorrat", menu "Aus dem Vorrat", `:93`). Both entries
sit seven lines apart in the same menu. Four buttons read "In den Vorrat";
three go to the ideas (Explore, Article, Ideas) and one (Ort suchen,
`TripPlaceSearchView.swift:96`) goes to the leg pool. "Schon im Vorrat" means
opposite things in `TripPlaceSearchView.swift:88` and
`TripExploreView.swift:285`, distinguishable only by icon.

**T2 — Seven words for one object.**
Idee, Fund, Kandidat, Spot, Stopp/Fotostopp, Ort, Pin (plus Vorschlag,
Wunsch, Herzenswunsch in the ballot) all denote a place, in different life
phases the user cannot tell apart.

**T3 — Three words for a leg.**
Menu "Etappen (2)", screen title "Etappen", button "Stadt hinzufügen", dialog
"Stadt entfernen?", field "Name der Etappe" (`TripLegsView.swift:52-253`), and
in the new-plan form the same block is "Weiter nach" / "Noch eine Stadt"
(`TripNewPlanView.swift:147-151`). `TripDraftLegView.swift:72` tells the user
that a time "wird zum Fixpunkt", a term seen nowhere else.

**T4 — Two screens about people, three lines apart.**
"Wer plant mit" (participants, invitations) and "Wer fährt mit?" (travellers,
ages) in the same menu (`TripPlanDayView.swift:108, :151`). The delete dialog
of the plan list points to a third name, "Mitreisende", which is no screen.

**T5 — Three words for the trip itself.**
"Trip" (tab, photo mode), "Reise" (plan object: "Neue Reise", "Name der
Reise", "Reisetagebuch"), "Urlaubsplanung" (feature). `TripView.swift:114`
sells trip mode with "Reise-Album" although "Reise" means the plan everywhere
else.

**T6 — Anchor has three names.**
"Unterkunft" (`TripDayMapView.swift:119`), "Start & Ziel"
(`TripPlanDayView.swift:585`), "Ausflug" (`:776`). `leg.anchor` is the
accommodation, `day.anchor` the outing target, same code name.

**T7 — Split vocabulary.**
"Zweig", "Trennen", "Wieder zusammen", "Split" (`TripSplitView.swift:76-92`)
for one feature, with Denglish in body copy.

**T8 — Notification wording differs from banner wording.**
Start: "Für diesen Ort nicht mehr fragen" (notification,
`TripAutoStartMonitor.swift:93-100`) vs. "Hier nie fragen" (banner,
`TripView.swift:191`), the latter sounding app-wide while acting on a
~5.5 km grid cell. End: "Weiter unterwegs" vs. "Nein" (`TripView.swift:300-310`),
where "Nein" answers "Bist du zurück?" grammatically but not semantically.

**T9 — Five words for the confirm button.**
"Sichern" (fixpoint, anchor, spot edit, day shape), "Speichern" (legs, plan
settings), "Hinzufügen" (add leg), "Trennen" (split), "Umräumen" with
"Lassen" instead of "Abbrechen" (weather sheet, `TripPlanDayView.swift:451-455`).

### 1.3 Dead ends and missing feedback

**D1 — Errors on the day screen are invisible.**
`viewModel.errorMessage` is evaluated only when no plan is loaded
(`TripPlanDayView.swift:46`). The error paths of mark, move, setPinned, hide,
returnToPool, addFixpoint, removeFixpoint and saveNote
(`TripPlannerViewModel.swift:440-894`) all set it. Tapping "Erledigt" on a
bad connection does nothing visible. The offline banner says "Änderungen
brauchen eine Verbindung" but disables no control (`:347`). `TripPoolView`
and `TripPlanIdeasView` show no error at all, so "Für später merken",
"Übernehmen", "Ausblenden" and "In einen Block setzen" fail silently.

**D2 — Five error presentations in one feature.**
Alert (`TripView.swift:56`); red footnote as the *last* section of a list
(nearly every planner screen, below the fold when the list is full); red bar
in a safe-area inset (`TripLegsView.swift:153`); grey text where the empty
state would be, so a server error reads as "nothing found"
(`TripFoodListView.swift:50`); nothing (D1). Raw `error.localizedDescription`
everywhere, i.e. English `URLError` text for German users. No retry button
anywhere; only hidden pull-to-refresh.

**D3 — A failed delete removes the whole plan list.**
`TripPlansListView.swift:245-247` sets `errorMessage`; `:124-126` then swaps
the entire content for a non-scrollable `ContentUnavailableView`, so
`.refreshable` cannot be reached. Every non-organiser hits this because the
server rejects their delete, while the swipe action and the alert promise
"auch für alle, mit denen die Reise geteilt ist" (`:87-88, :146-156`).

**D4 — From an idea there is no way into a trip.**
`TripIdeasView.swift:337-358`: the idea detail offers only "Aus dem Vorrat
entfernen". The transition idea → trip (the point of the collection per
`docs/ideenvorrat.md` §4.3) exists only from the trip side. "Ausflug daraus"
(`TripIdeasNearbyView.swift:68`) is disabled without explanation whenever the
5 km neighbourhood is empty, so planning an outing from home is impossible.
`TripIdeasOutingView` can open blank with no refresh or empty state
(`:26-71`), and budget/radius (240 min, 25 km, `TripIdeaModels.swift:118-127`)
are neither shown nor changeable.

**D5 — Swipe-only actions without any hint.**
"Für später merken" (pool → collection) exists exclusively as a leading swipe
(`TripPoolView.swift:182-199`); the detail sheet does not offer it.
"Einplanen" is a leading swipe there and "In einen Block setzen" in the
detail. "Nicht jetzt" (`TripIdeasNearbyView.swift:41-48`) is a trailing swipe
whose permanent consequence (silenced after three times) is written nowhere.
Deleting a leg is swipe-only (`TripLegsView.swift:39-43`) while adding is a
button. The split/merge menu is a 12 pt grey chevron without label or
accessibility label (`TripPlanDayView.swift:923-940`).

**D6 — Manual mode is a dead end.**
The empty grid in the Trip tab says "fügst du Fotos später über die Auswahl
hinzu" (`TripView.swift:364-387`); that selection does not exist. Toggling
manual → automatic triggers no pass, the grid stays empty until some sync
happens.

**D7 — Two detail views for the same stop.**
From the map a half-height sheet with "Fertig" and one action ("Für diese
Reise ausblenden", `TripPinDetailSheet.swift:72-108`); from the day list a
push with edit, move, pin, return to pool, hide
(`TripPlanDayView.swift:1120-1177`).

**D8 — "Warum hier?" is missing on most planned stops.**
Reasons are read from `leg.pool` (`TripPlannerViewModel.swift:911-913`), and
the pool row is deleted when a spot is scheduled, so the question-mark button
rarely appears although the screen header promises it on every spot.

**D9 — A shared link is offered twice with different targets.**
`TripShareInbox.peek()` is read by both `TripPlansListView.swift:92` (target:
leg pool via picker) and `TripIdeasViewModel.checkShare` (`:244`, target:
idea collection). "Später" on the ideas screen only clears local state, so
the banner reappears in the list. A shared article link (no map coordinates)
is dropped silently on the ideas screen (`TripIdeasViewModel.swift:266-273`).

**D10 — Share review flow has no recovery.**
`TripShareReviewView.swift:32-34`: analysis failed → `ContentUnavailableView`
without retry; only "Fertig", no cancel. "Fertig" with unsaved suggestions
saves nothing and asks nothing (`:42-44`). "Verwerfen" in the plan list
clears the inbox irreversibly without confirmation
(`TripPlansListView.swift:184-187`).

**D11 — Invitation gives no result.**
`TripParticipantsView.swift:159-166` discards `added: Bool`; an unknown
e-mail looks exactly like success. No e-mail validation. The ideas
collection invite is an alert with a text field whose every failure reads
"Niemand mit dieser Adresse gefunden." (`TripIdeasViewModel.swift:560`), with
no list of invitees and no way to remove one although the endpoint exists.

**D12 — Blocked save hides its way out.**
`TripPlanSettingsView.swift:139-148`: after "Speichern" the `blockedReason`
and the "Nur speichern, Tage lassen" button appear as the second-to-last
section, behind the interest list. The user taps Save, the sheet stays, and
nothing visible happens.

**D13 — "Planen" is disabled without saying why.**
`TripNewPlanView.swift:58` / `TripNewPlanDraft.swift:80`: every leg needs a
confirmed coordinate. Typing a city without tapping a result, or adding a
half-filled second city, yields a dead button and no hint. "Wie lange?" only
sets `legs[0].days`; the total duration (`totalDays`) is never shown.
Interests can only be set via the free-text sentence at creation time, i.e.
only when the local LLM is up.

**D14 — Block picker closes on failure.**
`TripBlockPickerView.swift:65-70`: `choose` returns nothing; the caller
always sets `moving = nil`. The stop stays where it was, unexplained.
`overfullBlockIds` is set but never displayed (`TripPlannerViewModel.swift:504, 875`).

**D15 — Weather sheet without an action.**
When `proposal.blockedSentence` is set, "Vorschlag ansehen" opens a modal
with one sentence and "Lassen" only (`TripPlanDayView.swift:453-460`).

**D16 — Offline bundle is manual and buried.**
The only hint that the plan is missing offline is one line in
"Reisebereit?", itself two levels down in the More menu
(`TripOfflineView.swift:38-49`, `TripReadinessView.swift:155-165`).
`TripRunningPlan.swift:36-41` swallows network errors as "no running plan",
so exactly abroad and offline the app does not recognise the trip although
the bundle is on the device. Visit reports (`TripVisitMonitor.swift:150-156`)
are `try?` with no queue, so "Danach" later lacks entries with no
explanation.

**D17 — Auto-end suggestion only visible in the Trip tab.**
`refreshAutoEndSuggestion` runs only in `ActiveTripView` (`TripView.swift:277-286`).
The tab badge (`ContentView.swift:90-103`) covers trip mode and pending
*start* suggestions, not pending *end* suggestions; the comment in
`TripAutoStartMonitor.swift:22-24` claims otherwise.

### 1.4 Bugs with UX impact (verified)

**B1 — The photo-stop toggle is reset on every save.**
`TripSpotEdit.trimmed` (`TripSpotEditView.swift:66-75`) rebuilds the struct
without `photoStop`; `:161` saves `edit.trimmed`. Switch on, save, reopen:
off. For ideas the same sheet shows the toggle, but
`TripIdeasViewModel.update` never sends it and `TripSpotDetail(_ idea:)`
hard-codes `false` (`TripSpotDetailView.swift:396`).

**B2 — Participants cannot leave a trip.**
`TripParticipantsView.swift:139`: `me` is set only when `youOrganise`, and
then to the organiser's ID. For anyone else `mayRemove` is always `false`
and the "Verlassen" swipe never appears, contradicting the plan-list delete
dialog and `docs/ios-urlaubsplanung.md` §6.2.

**B3 — Plan list disappears after a failed delete.** See D3.

**B4 — Split form asks for raw data and has no cancel.**
`TripSplitView.swift:55`: meeting time is a free-text field "13:00" sent
unvalidated; `:72` asks for an "OSM-Referenz" to type. Every other editor
uses a `DatePicker` and the place finder. It is also the only editor
presented as a push (from a card menu, `TripPlanDayView.swift:927`), so Back
discards silently.

**B5 — Anchor "Ändern" clears the place instead of replacing it.**
`TripDayAnchorSheet.swift:77` sets `place = nil`; correcting only the return
time after a mis-tap requires searching the place again.

**B6 — Fixpoint duration silently dropped.**
Switching kind to "Abfahrt" sets the entered duration to 0
(`TripFixpointSheet.swift:99-109`, `TripPlannerViewModel.swift:573`) without
telling the user. "Sichern" is disabled without a title, with no hint (`:196`).

**B7 — Map slider never deactivates.**
`TripDayMapView.swift:205-208`: `sliderActive` is never reset (`_ = editing`);
after the first touch the marker and an enlarged pin stay active.

**B8 — "Essen in der Nähe" searches around the hotel, not the block.**
`TripPlanDayView.swift:993` passes `leg.anchor`, ignoring `day.anchor` and
the block's last stop. A chosen restaurant cannot be put into the plan
(`TripFoodListView.swift:110-126`), and raw `opening_hours` syntax is shown
(`:101-108`).

**B9 — Plan settings can overwrite a renamed first leg.**
`TripPlanSettingsView.swift:275, :394-396` re-sends the `firstLegTitle`
captured on open with every arrival change.

**B10 — The plan title typed in settings never shows on the day screen.**
`TripPlanDayView.swift:52` prefers `leg.title`; for a one-city trip the leg
title always wins while the plan list shows the new name.

**B11 — Ballot reloads two endpoints per vote.**
`TripBallotView.swift:193-209`: every tap reloads `votes` and `fairness`,
making the list jump during the thirty-spots-in-a-minute flow the code
comment describes.

**B12 — Explore drops note and source.**
`TripExploreViewModel.collect` (`:193-221`) sends neither `note` nor
`sourceUrl`; the detail passes `onSave: nil`, so no edit pencil.

**B13 — Capture sheet dismisses even on failure.**
`TripIdeaCaptureSheet.swift:68-78` always calls `dismiss()`; the error lands
as a small line above the clusters, invisible when scrolled.

**B14 — `TripIdeasView.isEmpty` requires `lastAddition == nil`.**
After a successful "Merken" whose reload returns nothing (foreign collection,
offline) the screen shows one grey line and no entry point (`:283-286`).

### 1.5 Inconsistencies

**I1 — Three save paradigms.** Cancel/Save sheets (plan settings, new plan);
Save-only push where Back discards (`TripLegEditView`,
`TripLegsView.swift:321-330`); auto-save without confirmation (participants,
travellers). One tap on "+" in travellers replans the whole trip with no
warning (`TripTravellersView.swift:121-130`), while the settings warn twice
in footers.

**I2 — Delete sometimes asks, sometimes not.** Asks: trip, leg. Does not:
outing (x-tap, `TripPlanDayView.swift:773`), participant, traveller, shared
find ("Verwerfen"), half-filled draft city (`TripNewPlanView.swift:138-142`).
The auto-end banner "Beenden" ends the trip without the confirmation dialog
the toolbar "Beenden" has (`TripView.swift:261-310`).

**I3 — Sheet vs. push for the same decision.** Second city in the draft:
push. Second city after creation: sheet (`TripAddLegView`); editing it:
push. Settings: the only sheet in a menu of pushes; "Tagesablauf ändern" a
sheet over a sheet.

**I4 — "Unterwegs", "Termin steht fest", "Ankunft" in three places.**
New-plan form (acts on `legs[0]`), plan settings ("one value for the whole
trip"), leg editor (per leg). None says its scope.

**I5 — Same button, different behaviour.** The route/map button on a stop
row (`TripPlanDayView.swift:1197-1213`) opens a pin via
`TripMapsPreference.load()` when planning (bypassing "jedes Mal fragen") and
starts navigation via a dialog when travelling. `TripMapsOpen.swift:38-43`:
with "Jedes Mal fragen", `pin(...)` silently goes to Apple Maps, contrary to
the settings footer.

**I6 — Large ranges as steppers.** Dwell time 5–480 min in steps of 5 (up to
95 taps; `TripIdeaCaptureSheet.swift:48`, `TripSpotEditView.swift:128`,
`TripShareReviewView.swift:119`). Anchor radius 300–10,000 m in steps of 250
(`TripNewPlanView.swift:103`, `TripDraftLegView.swift:37`).

**I7 — Empty states in four wordings**, some without an action
("Noch keine Ideen", "Der Vorrat ist leer", "Nichts Gesammeltes hier", "Hier
nichts von euch"). `TripTravellersView.swift:68-75` uses a grey footnote
instead of `ContentUnavailableView`. `TripPlaceSearchView` has no initial
state at all before the first search. `TripSharePickerView` shows an empty
"Reise" section and a disabled "Weiter" when there are no plans.

**I8 — Technical jargon as user text.** "Zwei-Wege" / copy / sync / bisync
picker in the Trip tab with no explanation (`TripView.swift:339-346`), while
the explanatory sentence lives in `SyncSettingsView.swift:38`. Switching to
sync propagates deletions into a possibly shared album without warning.
"OpenStreetMap" in body copy; `way:213850482` as a row title
(`TripPlaceSearchView.swift:70`, `TripShareReviewView.swift:169-173`)
although `TripBallotEntry` explicitly forbids exactly that.

**I9 — Form ordering.** "Name der Reise" and "Termin steht fest" live under
"Wie lange?" (`TripNewPlanView.swift:176-189`); the city name field sits
under the "Unterkunft" heading (`:79`).

**I10 — Maps settings screen.** Picker title hidden (`labelsHidden`), the
"Jedes Mal fragen" option disappears when Google Maps is uninstalled, so the
user cannot see their own setting (`TripMapsSettingsView.swift:33-45`).

### 1.6 Effort: too many taps for common actions

**E1 — Add a second stop to a filled block: 7 taps.** "Aus dem Vorrat füllen"
appears only when `block.stops.isEmpty` (`TripPlanDayView.swift:1000-1017`);
otherwise More → Vorrat → row → detail → "In einen Block setzen" → sheet →
day → block.

**E2 — Move a stop: 4 taps**, no drag, no swipe, no context menu, although
`move(_:toDayIndex:toBlockId:position:)` knows a position.

**E3 — Remember the place I am standing at: 5 interactions** and two screen
changes (Trip → Ideen → + → sheet → Merken) although `addHere` needs only
the location.

**E4 — Shared link → pool: 5 interactions**, even with exactly one trip and
an unambiguous place where the picker is already prefilled.

**E5 — Change tempo or transport: 6 steps** via More → scroll →
Einstellungen → field → Speichern → reload.

**E6 — Change the accommodation: 5 levels**, although it is printed
prominently in the non-tappable day header (`TripPlanDayView.swift:530-560`).

**E7 — Day navigation.** The day picker does not scroll to the selected day
(no `ScrollViewReader`, `:635-680`); no horizontal swipe between days; no
"Heute" button; two code paths for changing the day with different logic
(`:640` vs. `select(leg:)`).

**E8 — Stop row with up to six tap targets** (pin, camera, name, map/route,
ellipsis menu, question mark) with `.buttonStyle(.plain)` and no minimum
size (`:1104-1250`). Ballot buttons about 28 pt, icon-only, heart without
accessibility label, greyed without reason (`TripBallotView.swift:147-173`).

### 1.7 The eight add-a-place paths

| # | Where | Label | Lands in | Note? | Duration? | Feedback |
|---|---|---|---|---|---|---|
| 1 | `TripIdeasView.swift:152` → capture sheet | "Das hier merken" | idea collection | yes | yes | server sentence |
| 2 | `TripIdeasView.swift:264` | "In den Vorrat" | idea collection | yes | yes | server sentence |
| 3 | `TripExploreView.swift:305` | "In den Vorrat" | idea collection | no | no | sentence on the Explore list |
| 4 | `TripArticleReadView.swift:274` | "In den Vorrat" | idea collection | quote auto | only without OSM hit | sentence |
| 5 | `TripPlaceSearchView.swift:96` | "In den Vorrat" | **leg pool** | no | 45 min fallback | "im Vorrat" |
| 6 | `TripPoolView.swift:193` (swipe only) | "Für später merken" | idea collection | – | – | one line |
| 7 | `TripPlanIdeasView.swift:70` | "Übernehmen" | leg pool | – | – | checkmark only |
| 8 | `TripPlansListView.swift:179` → picker → review | "Übernehmen" / "Fund" | leg pool | yes | yes | own screen |

`TripPlanIdeasView` additionally titles sections "Etappe 1/2" although legs
have names, and its rows are not tappable (no map, no note, no source).

### 1.8 Smaller issues

- **X1** `TripExploreView.swift:130`: "Artikel auslesen…" is the third entry
  of a filter-looking menu and disabled until an area is chosen, unexplained.
- **X2** `TripIdeasView.swift:141`: "Von selbst melden" is a bare toggle in
  the overflow menu that triggers "Always" location and push permission
  prompts with no explanation of radius or frequency.
- **X3** `TripIdeasView.swift:163-181`: four controls plus title in one
  navigation bar; "Gegend erkunden" and "Entdecken" name the same screen.
- **X4** `TripIdeasViewModel.nameClusters(limit: 8)`: from the ninth cluster
  on, headers read "Ein Ort", "Ein Ort", "2 Orte".
- **X5** `TripIdeaModels.swift:43-51`: row subtitle shows note *or* "von X",
  never both; the author disappears as soon as a note exists.
- **X6** `TripExploreView.swift:144`: chip changes reload without any
  loading indicator.
- **X7** `TripDayMapView.swift:79-84`: the legend for three coloured pin
  types is behind an info icon; "Tippen für Details" is inside it.
- **X8** `TripPlanDayView.swift:1026-1037`: "Ganzen Block in Karten öffnen"
  is styled like a grey footnote, not like an action.
- **X9** `TripSpotEditView.swift:153`: title "Notiz zum Spot" for a form with
  title, note, link, dwell time and photo stop.
- **X10** `TripPlansListView.swift:207, :223`: "läuft" chip and "Läuft — Tag
  3 von 7" label in the same cell. Opening a plan after creation and via a
  row builds two separate `TripPlannerViewModel`s; the last viewed day is
  lost.
- **X11** `TripTravellersView`: travellers outside the household cannot be
  added, `shortWalks` is displayed but not settable, and the organiser role
  cannot be transferred, all three promised in the concept doc.
- **X12** `TripTravellersView.swift:139-146`: travellers and suggestions are
  loaded in one `do`; a failing suggestions call empties the working list.
- **X13** `TripPlanSettingsView.swift:163` / `TripNewPlanView.swift:40`:
  "Abbrechen" discards a fully filled form without asking.
- **X14** `SyncSettingsView.swift:14` duplicates the key
  `"trip.suggestions.enabled"` as a string literal instead of using
  `TripSuggestionSettings`.
- **X15** `TripMapsHandoff.swift:4` and `TripMapsSettingsView.swift:4` cite
  "§9.1", which in `docs/ios-trip-mode.md` is the auto-end section.

---

## 2. Proposals

Ordered so that each step leaves the app consistent. Steps 1–4 are the
structural changes and pay for most of chapter 1; steps 5–8 are bounded
fixes that can be done in any order.

### 2.1 One notion of "on the trip" (S2, S4, D17)

- Introduce a single `TripPresence` (or extend `TripRunningPlan`) that
  answers "is a trip happening now" as `TripStore.isActive || runningPlan != nil`.
  `TripLaunchRoute.opensOnTrip` already encodes the rule; reuse it.
- `TripPlanDayView.isTravelling` reads that value. "Route hierher" and "Ab
  hier umplanen" then work on the planned day without trip mode. Show "Ab
  hier umplanen" whenever it is today, and explain in one line when it has
  nothing to do (no current block).
- Replace the once-per-launch auto-push in `TripView` with a permanent,
  tappable banner "„X" läuft heute · Tag 3 von 7 · Plan öffnen". Show that
  banner in `ActiveTripView` too, above the options bar.
- Merge the two banners: when a plan runs today and an auto-start suggestion
  is pending, show one banner with the plan title as prefill.
- After "Beenden", show one line for the grace period: "„X" wurde beendet.
  Nachzügler-Fotos werden bis morgen ergänzt."
- Extend the tab badge to `autoEnd.pendingSuggestion != nil` and use the
  filled icon for a running plan as well.

### 2.2 Make the planner a peer of the photo mode (S1, S3, E5, E6)

- Give the Trip tab a segmented top ("Aufnehmen" / "Planen") or make the
  plan list the tab root when at least one plan exists, with trip mode as a
  card at the top. Either way the planner stops being an icon.
- Restructure the More menu into `Section`s:
  - **Dieser Tag**: Karte, Ort suchen, Abendlicht, Feste Zeit, Ausflug.
  - **Diese Reise**: Vorrat, Aus der Ideensammlung, Etappen, Abstimmen,
    Einstellungen.
  - **Gruppe**: Planen mit, Reisegruppe.
- Move trip-wide, time-bound screens out of the day menu and onto the plan
  list row (context menu and, date-dependent, inline):
  - "Reisebereit?" appears on the row from 48 h before the start date.
  - "Danach" appears on the row once the end date has passed.
  - Dokumente, Änderungen, Unterwegs ohne Netz in the row's context menu.
- Make the day header (Start/Ziel) a `NavigationLink` to the leg editor.
- Put Tempo and Verkehrsmittel as quick controls into the day header's
  context menu or a compact chip row, saving directly.

### 2.3 Consolidate settings (S5, I8, I10, T8, X14)

- One entry point "Trip & Reise" on the top level of the Settings tab with:
  Karten-App, Trip-Vorschläge (with region reset), Zuhause (read-only
  display of the server value and radius, with "noch nicht bestimmt" while
  `null`), and a link to it from the Trip tab toolbar.
- Add "Immer diese App verwenden" as a third row in the "Navigation öffnen
  mit" dialog, and make `pin(...)` honour "Jedes Mal fragen" or state in the
  footer that only routes ask.
- Maps settings: keep the picker title, always show the chosen option
  (disabled with an explanatory line when the app is missing).
- Sync-mode picker in the Trip tab: one explanatory line per option; a
  one-time confirmation when switching to sync/bisync ("Löschungen auf dem
  iPhone werden ins Album übernommen").
- Unify notification and banner labels: "In dieser Gegend nicht mehr
  fragen"; "Trip beenden" / "Weiter unterwegs". Route the banner's "Beenden"
  through the same confirmation dialog as the toolbar.
- Replace the string literal in `SyncSettingsView` with
  `TripSuggestionSettings.key`.

### 2.4 One vocabulary (T1–T7, T9)

Add a glossary section to `docs/ios-urlaubsplanung.md` and apply it across
all labels. Proposed terms:

| Concept | Term | Replaces |
|---|---|---|
| Photo mode | Trip | Trip-Modus, Reise-Album → "Trip-Album" |
| Plan object | Reise | Urlaub, Plan |
| Trip-independent collection | Ideen / Ideensammlung | Ideenvorrat, Mein Vorrat |
| Per-leg candidates | Kandidaten (dieser Etappe) | Vorrat |
| A place, unscheduled | Ort | Idee, Fund, Spot, Kandidat, Pin |
| A place in a day | Stopp | Spot, Fotostopp stays as attribute |
| Leg | Stadt | Etappe (internal only) |
| Hard time | Feste Zeit | Fixpunkt |
| Accommodation | Unterkunft | Start & Ziel, Anker |
| Outing target | Ausflugsziel | Ausflug (as a place) |
| Split | Gruppe trennen / wieder zusammen | Zweig, Split |
| People planning | Planen mit | Wer plant mit |
| People travelling | Reisegruppe | Wer fährt mit?, Mitreisende |
| Confirm | Sichern | Speichern, Hinzufügen, Trennen, Umräumen |
| Cancel | Abbrechen | Lassen |

Concretely: rename menu entry "Aus dem Vorrat" to "Aus den Ideen
übernehmen"; rename "Schon im Vorrat" to "Schon bei den Kandidaten" (place
search) and "Schon in den Ideen" (Explore, Article); rename
`TripSpotEditView` title to "Ort bearbeiten".

### 2.5 One error model (D1, D2, D10, D12, D14, B13)

- Add a `.plannerErrorBanner($errorMessage, retry:)` view modifier used by
  every planner screen: a banner at the *top* of the list with a "Erneut
  versuchen" button, dismissible. Ladefehler with empty content keep
  `ContentUnavailableView`, but with a retry button and scrollable
  container.
- Attach it to `TripPlanDayView`, `TripPoolView`, `TripPlanIdeasView`,
  `TripFoodListView`.
- Add a small `UserFacingError` mapping for `APIError` / `URLError` (offline,
  timeout, permission denied, not found) so raw `localizedDescription` is
  never shown.
- When `offlineSince != nil`, disable write controls on the day screen (or
  queue and show "wird gesendet, sobald Netz da ist").
- Sheets that perform a write (`TripBlockPickerView`, `TripIdeaCaptureSheet`,
  share review) close only on success; on failure show the error inside the
  sheet.
- `blockedReason` in plan settings becomes an alert with two buttons
  ("Tage neu planen" / "Nur speichern").
- Share review: add "Nochmal versuchen" on analysis failure, "Alle
  übernehmen", and a confirmation when leaving with unsaved suggestions;
  "Verwerfen" in the plan list asks first.
- Weather sheet: when only `blockedSentence` exists, show it inline on the
  card instead of opening a sheet.

### 2.6 Fix the verified bugs (B1–B14, D3, D8)

| ID | Fix |
|---|---|
| B1 | Pass `photoStop: photoStop` through `TripSpotEdit.trimmed`; hide the toggle for ideas until the ideas endpoint accepts it. |
| B2 | Set `me` from the session's own user ID on every load (the auth data already knows it), independent of `youOrganise`. Show "Verlassen" as a visible button on the own row, with confirmation. |
| B3 / D3 | Delete errors go to an alert; the list stays. Offer the swipe "Löschen" only when `youOrganise`, otherwise "Reise verlassen". Requires `youOrganise` (or organiser ID) on `TripPlanSummary`. |
| B4 | Rebuild `TripSplitView` as a sheet with Abbrechen/Sichern, `DatePicker(.hourAndMinute)` for the meeting time, and a place picker fed from the leg's candidates instead of a raw OSM ref field. Label the split menu chevron. |
| B5 | "Ändern" opens the search with the current place kept until a new one is tapped. |
| B6 | When switching to "Abfahrt", show "Die Dauer entfällt bei einer Abfahrt" and hide the stepper; prefill the title from the kind so Sichern is enabled, or add a footer "Ein Name ist nötig". |
| B7 | `sliderActive = editing`. |
| B8 | Pass `day.anchor ?? lastStopOfBlock ?? leg.anchor` to the food list; add "In diesen Block setzen" per row; prefix opening hours with "Laut OpenStreetMap:". |
| B9 | Read the current first-leg title at save time instead of caching it on open. |
| B10 | Title: `plan.title ?? leg.title`; show the leg as subtitle when there is more than one. |
| B11 | Apply the `POST /votes` response locally (`heartsLeft`, own vote); reload fairness only on pull-to-refresh. |
| B12 | Offer the capture sheet (optional, skippable) from Explore; send `sourceUrl`. |
| B13 | Keep the sheet open on failure (see 2.5). |
| B14 | `isEmpty` ignores `lastAddition`; show the addition as a toast instead. |
| D8 | Persist the "why here" reasons on the stop when it leaves the pool (server: copy `reasons` into the stop row), or drop the promise from the header comment. |

### 2.7 Make the common paths short (E1–E8, D5, D7)

- **Add a stop to any block**: a "Stopp hinzufügen" row at the end of every
  block card, opening the candidate list pre-filtered to what fits the
  remaining budget. This alone turns 7 taps into 2.
- **Move a stop**: context menu on the stop row with "In einen anderen
  Block" and "Zurück zu den Kandidaten"; keep the detail screen as the long
  form. Consider `.draggable` between blocks as a later step.
- **Stop row**: reduce to name + one status chip + one ellipsis menu
  (Erledigt / Übersprungen / Route / Anheften / Verschieben / Warum hier).
  Minimum 44 pt targets. Same in the ballot: a segmented control with text
  labels, heart as its own row "Herzenswünsche: 1 von 3 frei".
- **Swipe-only actions** get a visible twin: "Für später merken" and
  "Einplanen" in the pool detail sheet; "Stadt entfernen" via `EditButton`
  or context menu; footer under "Nicht jetzt" explaining the three-strikes
  rule.
- **One detail screen**: `TripPinDetailSheet` gains a "Details" link to
  `TripSpotDetailView`, or embeds the same action block.
- **Day navigation**: `ScrollViewReader` scrolling to the selected day;
  horizontal swipe on the content to change the day; a "Heute" button while
  the trip runs; route both day-change paths through `select(dayIndex:)`.
- **Remember here**: a "Das hier merken" action directly on the Trip tab (and
  as an App Shortcut); note and duration are editable afterwards in the
  detail.
- **Shared link**: skip the picker when there is exactly one trip and one
  unambiguous match; otherwise a single "Übernehmen" screen with a target
  choice (Ideen / Reise X), replacing the two competing banners (D9). An
  article link offers "Artikel auslesen" there.

### 2.8 Consistent forms and flows (I1–I7, I9, D11, D13, D4, D6, X1–X13)

- **Save paradigm**: every editor is a sheet with Abbrechen/Sichern
  (`TripLegEditView`, split), or an auto-saving list with an undo toast
  (participants, travellers). Before the first travellers change that
  replans, confirm once: "Die Tage werden neu geplant."
- **Destructive actions** always confirm: outing x-tap, participant,
  traveller, draft city, shared find.
- **Scope labels**: in plan settings, footer "Gilt für alle Städte"; in the
  leg editor, "Nur diese Stadt". Remove transport/date/arrival from the
  new-plan form's "Wie lange?" section, or label them "erste Stadt".
- **New-plan form**: move "Name der Reise" to its own top section; move
  "Stadt (optional)" under "Weiter nach" / rename the section "Wo"; show
  "insgesamt N Tage" in the footer; a footer under the disabled Planen
  button ("Für jede Stadt einen Ort auf der Karte bestätigen"); add the
  interests toggle list to the form.
- **Steppers**: preset chips (30 Min · 1 h · 2 h · halber Tag; 500 m · 1 km
  · 3 km) plus a stepper for fine-tuning.
- **Empty states**: one wording family ("Hier ist noch nichts") and always
  an action. Initial state for place search; "Reise anlegen" in the share
  picker and the plan-list banner when there are no plans.
- **Invitations**: show `added == false` as "Zu dieser Adresse gibt es kein
  Konto"; validate the e-mail format; give the ideas collection a proper
  "Wer schreibt mit" screen with a list and removal, modelled on
  `TripParticipantsView`.
- **Ideas → trip**: "In eine Reise übernehmen" with a plan picker in the idea
  detail (`POST /plans/:id/ideas/take` exists). "Ausflug daraus" also per
  cluster in `TripIdeasView`, with the cluster centre as anchor; explain the
  disabled state; give `TripIdeasOutingView` an empty state, pull-to-refresh
  and a budget picker (2 h / halber Tag / ganzer Tag).
- **Manual mode**: either build the selection grid or hide the toggle until
  it exists; trigger a pass when switching to automatic.
- **Small items**: X1 own action in the Explore empty state; X2 toggle with
  one explanatory sentence in its own section; X3 "In der Nähe" and
  "Entdecken" as two rows at the top of the list, one name; X4 name
  clusters lazily on appear; X5 note as line 2, author as line 3; X6 loading
  row; X7 show the legend once on first open; X8 `.bordered`; X9 title "Ort
  bearbeiten"; X10 drop the chip or the label, share one view model per plan
  id; X11 add manual traveller entry with optional birth date, a
  `shortWalks` toggle per traveller, and "Rolle übergeben"; X12 load
  suggestions separately; X13 `interactiveDismissDisabled` with a
  confirmation when the form is dirty; X15 fix the section references.

### 2.9 Offline and background (D16)

- 24 h before a dated trip starts, offer once: "Plan fürs Gerät laden".
- `TripRunningPlan.refresh` falls back to the offline bundle on network
  error instead of `nil`.
- Queue failed visit reports locally and flush on the next connection.

### 2.10 Suggested order

1. 2.1 (one "on the trip") and 2.6 rows B1, B2, B3, B4 — small diffs, high
   impact.
2. 2.5 error model, since every later step builds on visible errors.
3. 2.2 menu and plan-list restructuring, 2.7 "Stopp hinzufügen" and stop-row
   cleanup.
4. 2.4 vocabulary pass across all labels (one PR, mechanical).
5. 2.3 settings, 2.8 forms, 2.9 offline.

Each step should be verified with the Storybook-independent iOS previews
and, where behaviour changes, a short manual run in the simulator with a
dated plan whose start date is today.

---

## 3. Implementation status and deviations

Implemented in seven pull requests, merged in order on 2026-09-14:
#1223 (this plan), #1224 (2.1, 2.6), #1225 (2.5), #1226 (2.2, 2.7),
#1227 (2.4), #1228 (2.3, 2.8), #1229 (2.8 ideas, 2.9, B8, B12, D9,
X1–X7). Each was compiled and tested by the iOS CI before merging; the
backend suite ran before every push. Everything below is a difference
between chapter 2 and what landed — either done differently, partially,
or not at all.

### 3.1 Done differently

| Section | Plan | What landed | Why |
|---|---|---|---|
| 2.1 badge | Badge also for a pending auto-**end** suggestion | Tab icon fills for trip mode **or** a running plan; the badge still covers trip mode and pending **start** suggestions only | `TripAutoEndPreferences.pendingSuggestion` is a static `UserDefaults` read, not observable; wiring it into the tab bar needs an observable monitor first |
| 2.2 tab root | Segmented "Aufnehmen / Planen" or the plan list as tab root | Done in a follow-up PR as the segmented control, in the navigation bar where the title was (`TripTabMode`). The half is remembered; on appearance trip mode wins, then a plan running today opens "Planen", otherwise the remembered half. The Trip tab keeps the permanent "läuft heute" banner and the settings link on "Aufnehmen" | The plan list is embedded rather than pushed, so the tab holds the one destination for an opened plan; the earlier "left for a separate change" was that change |
| 2.2 menu | Move trip-wide screens **out** of the day menu onto the plan list | Both: the day menu keeps them in a "Rund um die Reise" submenu, and the plan list row offers them as a context menu plus the time-bound inline prompts | Somebody standing in the day screen still needs Dokumente; the submenu keeps them reachable without cluttering the day |
| 2.2 quick controls | Tempo / Verkehrsmittel as chips in the day header | The header opens the city editor (sheet); tempo stays in Einstellungen | The header already carries the transport; two more controls there fought the day picker for space |
| 2.3 maps | `pin(...)` honours "Jedes Mal fragen" **or** the footer says only routes ask | Footer says it; `pin(...)` unchanged. The dialog gained "Immer Apple Karten / Immer Google Maps" | Asking on every "auf der Karte zeigen" tap would make the planning-mode button a dialog |
| 2.3 home | Show home + radius, "noch nicht bestimmt" while null | As planned, reverse-geocoded to a place name; the radius is the constant `TripAutoEndPreferences.homeArrivalRadiusMeters` | — |
| 2.4 confirm word | Every confirm is "Sichern" | "Sichern" everywhere except the weather sheet ("Umräumen", its cancel is now "Abbrechen") and the add-city sheet ("Hinzufügen") | Those two name the action; "Sichern" would say less |
| 2.5 dismiss | Every banner dismissible | Plan settings' banner has no dismiss | `errorMessage` there is `private(set)` on purpose; the sheet closes on save anyway |
| 2.6 B11 | Apply the vote response locally | Reload only the ballot after a vote; fairness reloads on apply and pull-to-refresh | The entry's `wants`/`hearts` name lists cannot be updated locally without knowing the voter's display name |
| 2.7 stop row | Name + one menu | Name + one 44 pt menu (also long press), keeping the small pin and camera glyphs as status marks | They are indicators, not targets |
| 2.7 move | Context menu **and** consider `.draggable` | Context menu / row menu only | Drag between blocks that are not on screen has no natural gesture here |
| 2.7 shared link | One "Übernehmen" screen with a target choice replacing two banners | "Später" on the ideas screen is remembered for the session; an article link becomes a row leading to Entdecken; the plan-list banner is unchanged | A combined screen needs a shared inbox state machine across two view models |
| 2.8 save paradigm | Auto-saving lists get an undo toast | Participants and travellers stay auto-save with confirmations before removing (and before the first traveller change); no undo toast | The server has no undo for these; a toast that cannot undo would lie |
| 2.8 draft city | Confirm before deleting a draft city | Confirms only when the row already holds a place; an empty row deletes at once | An empty row has nothing to lose |
| 2.8 outing budget | "2 h / halber Tag / ganzer Tag" | Segmented `TripOutingBudget` 120 / 240 / 480 min (same labels); the endpoint already accepted `budgetMinutes`, `lat`, `lon` | — |
| 2.8 X10 | Drop the chip **and** share one view model per plan id | Chip dropped; each navigation still builds its own `TripPlannerViewModel` | Sharing needs a cache keyed by plan id; small, but not done |
| 2.8 X13 | `interactiveDismissDisabled` on new-plan and plan-settings forms | New-plan form only (`isDirty` from anchor, title, sentence, cities, interests) | Plan settings have no clean "dirty" baseline yet |
| 2.9 offline offer | 24 h before a dated trip, offer "Plan fürs Gerät laden" once | "Reisebereit?" is offered inline on the plan-list row two days before departure, and that screen has a prominent "Plan fürs Gerät laden" button when the plan is not stored | The prompt lives where the evening-before checklist already is; no separate scheduling |
| 2.9 running plan | Fall back to the offline bundle on network error | Keeps the **last known** running plan when the error means unreachable (`TripOfflineReach.meansUnreachable`); a real 404/403 still clears it | Deriving a `TripPlanSummary` from the bundle was more code for the same banner |
| 2.10 order | 2.1 + B1–B4, then 2.5, then 2.2/2.7, then 2.4, then 2.3/2.8/2.9 | As planned, with 2.8's ideas part, 2.9, B8 and B12 split into a sixth PR | — |

### 3.2 Not done

| ID | Item | Status |
|---|---|---|
| D8 | Persist "Warum hier?" reasons on the stop when it leaves the pool (server) | Done in a follow-up PR: `trip_plan_stops.reasons` (migration 0198) is written by every path that creates a stop (initial plan, placement from the pool, redistribution, weather shuffle, split branches) and read back on the stop; returning a spot to the pool brings them back. `TripStop.reasons` is optional for an older server, and the day screen falls back to the pool entry then |
| D11 (ideas) | "Wer schreibt mit" screen for the idea collection with a list of invitees and removal | Done in a follow-up PR, with a change of model: invitations (trips and ideas) pick from the household like the album share instead of typing an address (`GET /trip-planner/shareable-users`); the ideas list is one list across every collection the person may write into (`GET /ideas` without `ownerId`, folded where two collections hold the same place); `GET /ideas/members` lists who writes into mine. Two people who collected separately and then let each other in see one list; nothing is merged or moved. See `docs/ideenvorrat.md` §4 |
| D6 | Build the manual-mode selection grid, or hide the toggle | Neither. The toggle stays; the empty state now says truthfully that photos are added by putting them into the iOS album |
| E3 | "Das hier merken" directly on the Trip tab and as an App Shortcut | Not done; the capture stays behind Ideen → + |
| X11 | Travellers outside the household, a per-traveller `shortWalks` toggle, transferring the organiser role | Done in a follow-up PR: "Jemanden eintragen" (name, optional birth date, "Kürzere Wege") on the Reisegruppe screen; "Kürzere Wege" as a toggle per traveller (`POST /travellers/update`, organiser only, re-plans); "Rolle übergeben" as a swipe action on Planen mit (`POST /participants/hand-over`, a swap: the old organiser stays as participant) |
| X15 | "§9.1" references in `TripMapsHandoff.swift` / `TripMapsSettingsView.swift` | Dropped: they cite §9.1 of `ios-urlaubsplanung.md` ("Hinaus: was die App abgibt"), which is correct. The finding was wrong |
| I5 (pin) | Planning-mode "auf der Karte zeigen" bypasses "Jedes Mal fragen" | Kept as is; documented in the maps settings footer (see 3.1) |
| S1 | Planner as a peer of the photo mode at the tab root | Done in a follow-up PR (see 3.1, 2.2 tab root): "Aufnehmen / Planen" segmented control on the Trip tab, the planner icon is gone |

### 3.3 Added beyond the plan

- `TripDurationPicker` and `TripRadiusPicker` (`TripPresetPickers.swift`): preset chips plus a stepper, used in five forms.
- `TripErrorBanner.swift`: the banner modifier and `TripErrorText`, which maps `URLError` and `APIError` to German sentences; 61 `localizedDescription` uses replaced.
- `TripSettingsView.swift`: the "Trip & Reise" screen.
- `TripVisitReportQueue` (in `TripVisitMonitor.swift`): failed visit reports are queued in `UserDefaults` (cap 100) and flushed later.
- `TripIdeaTakeSheet` (in `TripIdeasView.swift`): the plan picker behind "In eine Reise übernehmen".
- The share extension's own copy of the collection labels follows the glossary (`F4milShare/ShareWireTypes.swift`, `ShareProposalsView.swift`, `TripShareCapture.swift`).
- Backend: `youOrganise` on `PlanSummary` (`trip-planner/plan-store.ts`), with a test in `shares.test.ts`.
- Unit tests: `TripErrorTextTests`, `TripDayNavigationTests`, `TripParticipantsInviteTests`, `TripVisitReportQueueTests`, the organiser-flag decode in `TripPlanModelsTests`, `testTrimmingKeepsThePhotoStop` in `TripSpotDetailTests`, and extensions of `TripIdeasTests` and `TripIdeasOutingTests`.

### 3.4 Found by the iOS CI, fixed before merging

Three things the sandbox (no Swift toolchain) could not catch:

- `TripArticleReadView` and `TripExploreView` called `TripIdeaCaptureSheet` with a closure that returned nothing after its `onSave` was changed to return `Bool`.
- `ShareWireTypesTests` asserted on the old collection labels once the app-side copy was renamed; the extension's copy had to follow.
- `TripExploreView.body` grew past what the type checker finishes in time; it is now split into the list, its chrome, the area menu and the sheets.

### 3.5 Open follow-ups, in suggested order

1. ~~D8 — reasons travel with the stop (server + `TripSpotDetail(stop)`).~~ Done (see 3.2).
2. ~~D11 — invitee list and removal for the idea collection (needs a list endpoint).~~ Done (see 3.2).
3. ~~S1 — planner and photo mode as peers at the tab root, once the launch routing is revisited.~~ Done (see 3.1).
4. ~~X11 — manual travellers, `shortWalks` per person, organiser hand-over (backend first).~~ Done (see 3.2).
5. D17 — an observable auto-end monitor so the tab badge can show a pending end suggestion.
6. E3 — "Das hier merken" as a one-tap action on the Trip tab and as an App Shortcut.
7. X10 — one `TripPlannerViewModel` per plan id, so the last viewed day survives navigating away.

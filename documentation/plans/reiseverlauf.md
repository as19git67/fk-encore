# Itinerary: creating a trip and its stops on one screen

Status: stage 1 (backend) done, PR #1800. Stage 2 (iOS itinerary screen) done, PR #1802. Stage 3 (entry and day) done. Stage 4 open.

## The problem

A trip with three cities and the journeys between them takes seven sheets
today: "Neue Reise" makes one city only; every further city is a sheet of
its own ("Stadt hinzufügen", arrival time only), and every journey is a
third sheet ("Weiterreise einfügen", departure and arrival each as date
plus time). The same fact is entered in several places:

- The arrival time in a city can be entered on the city (time only), on
  the journey (date plus time) and, for the first city, in the settings.
  Saving the journey silently overwrites the city's value.
- The date is split: a city knows "Erster Tag" without a time, the
  journey knows date and time. The journey overwrites the next city's
  first day.
- The length of a stay is set twice: by the "Tage" stepper of the city
  and by the departure date of the journey. A later change of the city
  does not move the journey, so the two drift apart
  (`PATCH …/legs/:i` moves this leg only, `frameJourney` in
  `transits.ts` moves the neighbours).
- A journey is refused while a neighbouring city has no date, although
  "Stadt hinzufügen" allows cities without one. Cities cannot be
  inserted in the middle or reordered.

## The idea: one chain, one date

A trip is a chain: home, journey, stay, journey, stay, journey home. The
chain is created and edited on one screen, the **itinerary**
(Reiseverlauf). Every fact has exactly one owner:

- A **stay** owns place, lodging, number of days and the mode of transport
  on site. It owns no date and no time.
- A **journey** owns its departure time, its arrival time, its mode and,
  when it takes longer than a day, the nights on the way. It owns no date.
- The **trip** owns exactly one date, its first day. Every other date is
  computed: stay 2 begins on the day journey 1 arrives; journey 2 leaves
  on the last day of stay 2.

Without a date the chain works the same way ("Tag 1 bis 3"). The date
can be added at any time; a separate "Termin steht fest" switch is gone.

Three sentences the user may say, and what they become:

| Sentence | Chain |
| --- | --- |
| "On 23 Nov I am in City A for 3 days" | first day 23 Nov; stay City A, 3 days. No home, so no journeys. |
| "A cruise starting 26 Nov in Port A, 13 days; 27 Nov 08:00 to 28 Nov 22:00 in Port B; 29 Nov 06:00 to 21:00 in Port C" | first day 26 Nov; one stay "Kreuzfahrt", 13 days, `quartersAboard`. Its days carry the port calls as day anchors: 27 Nov Port B from 08:00 (no return), 28 Nov Port B until 22:00, 29 Nov Port C 06:00–21:00; every other day is a sea day. No journey cards between ports, the ship moves by itself. |
| "Flight on 20 Feb to City B, three nights, then by train to City C, 4 nights in a named hotel" | first day 20 Feb; journey by plane, times open; stay City B 3 nights (= 4 days, the fourth with the departure); journey by train, times open; stay City C 4 nights, lodging named. |

Days and nights are both everyday language. The stepper on a stay shows
both ("4 Tage · 3 Nächte"); stored is `days`, as today. The departure day
belongs to the stay, so three nights are four days.

## Stage 1 — backend: the chain as the single source

`trip-planner/itinerary.ts`:

- `itineraryOf(plan)` reads the stored legs back as the chain: a transit
  leg becomes a journey with `departAt`, `arriveAt` and `nights =
  days − 1`; two stays without a transit leg between them get an implicit
  journey whose `arriveAt` is the next stay's `arriveMinutes` and whose
  `departAt` is the departure fixpoint `journeyDeparture` wrote on the
  previous stay's last day, when there is one. `nights` of such a journey
  is the calendar gap between the two stays.
- `deriveFrames(itinerary)` is pure and deterministic: for every stay its
  `startDate`, `days`, `arriveMinutes` (from the journey before) and the
  departure on its last day (from the journey after); for every journey
  with both times a transit leg frame with `startDate`, `days = nights +
  1`, `departMinutes` and `endMinutes`. The date cursor: a stay runs from
  the cursor over `days` days; a journey leaves on that last day and
  arrives `nights` days later; the next stay starts there. The arrival
  day is shared, as `frameJourney` already has it (§22.7).
- `GET /trip-planner/plans/:planId/itinerary` returns the chain with the
  computed dates per item, so no client has to compute them.
- `PUT /trip-planner/plans/:planId/itinerary` takes the whole chain.
  Stays keep their `legId`, so days, pool and votes survive a move; a stay
  missing from the chain is removed, one without `legId` is planned and
  inserted. A journey with both times is a transit leg (updated in place
  when it has a `legId`, else inserted); a journey with one or no time
  writes only what it knows (the arrival on the next stay, the departure
  on the previous one). A stay is re-planned only when what its days can
  hold changed (anchor, mode, length, radius, arrival, departure); a move
  or a new date is a frame update. Every refusal (`days < 1`, a journey
  arriving before it leaves, a stop already settled on a day that would be
  re-planned) happens before anything is written.
- The old endpoints `POST/PATCH/DELETE …/legs/:i` and
  `POST/PATCH …/transits` stay as they are until the app uses the chain
  (stage 2); they are removed in stage 4.

Tests in `itinerary.test.ts`: the derivation (dated, undated, overnight
journey, journey without times, cruise stay), reading a stored plan back,
and the endpoint (insert in the middle, reorder, remove in the middle,
change a length and see the later stays move, a settled stop refusing).

## Stage 2 — iOS: the itinerary screen

New `TripItineraryView`, opened by the pencil on the leg strip, by the
header of a leg's sheet, and the target of "Neue Reise": a vertical
timeline of stay and journey cards.

Done as described below, with these particulars: the chain is a value
type, `TripItineraryDraft` in `TripItinerary.swift`, that keeps the
alternation itself (a stay inserted brings its journey, a stay removed
merges the two journeys around it, home at both ends means a journey at
both ends) and derives the dates the same way `deriveFrames` does;
"Sichern" sends the whole chain in one `PUT`. The planner's journey
suggestion (§22.7) fills the open journey in the chain instead of
opening a form. Reordering uses the list's edit mode.

- A stay card, folded: place, lodging, days and the computed dates (grey,
  not editable). Unfolded: its fields in place, no sheet — lodging search
  or "Noch nichts gebucht" with a radius, stepper days · nights, mode on
  site, "Unterkunft fährt mit". A stay with the quarters aboard also
  lists its days with port and shore hours; tapping a day edits the day
  anchor in place.
- A journey card sits between two stays. Folded: "ab 10:00 · an 15:00 ·
  Bahn" and the computed date. Unfolded: departure, arrival, mode, nights
  on the way (default 0). Without times it says "Zeiten offen".
- Home is a plain row at top and bottom; with home set, there are journey
  cards for the way there and the way home.
- A plus on the line inserts a stay; the journey into it appears in the
  same step, prefilled. The new stay opens unfolded with the place search
  first. Drag to reorder (journeys stay attached to their neighbours),
  swipe to delete (the two adjacent journeys become one).
- The one date sits in the header ("Erster Tag: Mo 3.6.2027" or "Noch
  ohne Datum"); every change recomputes the other cards at once.
- `TripLegsView`, `TripAddLegView`, `TripLegEditView`, `TripTransitView`
  and `TripDraftLegView` are gone; the stay card took the draft view's
  fields. `TripTransitSlots` and `TripTransitPlanning` went with them.

## Stage 3 — iOS: entry and day

"Neue Reise" asks only name, first place, days and the first day, then
lands in the itinerary. Settings lose "Wie?" and "Ankunft am ersten Tag".
The ends of a journey in the day's frame band link into the itinerary
with that journey unfolded. `TripLegSheet` loses the push links to the
old editors.

Done as described, with these particulars: `TripNewPlanView` keeps
name, lodging, length and date and says in its footer that the way
there, the arrival and the mode are the itinerary's; the draft's mode
stays at its default and is changed there. `TripPlanSettingsView` keeps
pace and group under "Tempo und Begleitung" and no longer patches the
first leg. The way into the itinerary from a day is
`TripItineraryFocus` (`.leg`, `.journeyBefore`, `.journeyAfter`),
resolved by `TripItineraryDraft.item(focused:)`: the departure a
journey wrote on a stay's last day (`TripLeg.isJourneyDeparture`, the
same rule as `isJourneyDeparture` in `aboard.ts`), both ends of a
transit leg, and the "Ankunft" in the first day's header open the
itinerary with that journey unfolded. The multi-city fields of
`TripNewPlanDraft` are dead code until stage 4.

## Stage 4 — clean-up

Dead multi-city draft code in `TripNewPlanDraft` and
`TripNewPlanViewModel`, one word per level in the UI (Reise, Aufenthalt,
Weiterreise, Ort), `documentation/ios-urlaubsplanung.md` §22.7, §25.1,
§25.2 and §25.5 updated, the old leg and transit endpoints removed.

## Decisions taken (2026-11-02)

- Length is stored in days; the UI shows days and nights side by side.
- "Neue Reise" lands in the itinerary, "Planen" leads on to the day view.
- Between two stays there is always a journey, "Zeiten offen" until
  somebody knows them.
- A change in the itinerary may shorten planned days; undo exists
  (`…/ops/undo`).
- The level is called Aufenthalt in the UI.

import SwiftUI

/// One day of a plan: a card per block, spots as compact rows with the
/// way between them, and a utilisation line underneath (§8.3).
///
/// **The one screen for a day**, planning and walking alike. There used
/// to be a second one — "Unterwegs" (§8.5) — and the split turned out
/// to be the wrong seam: half the actions lived here and half there, so
/// using the planner meant switching back and forth for tasks that
/// belong to the same afternoon. §8.3 and §8.5 describe two *modes* of
/// one day, not two screens with different abilities, so the day is one
/// screen that knows whether you are standing in it: while a trip runs
/// the current block is marked, carries "Umplanen", and every stop
/// offers what you reach for on the spot — done, skipped, and the way
/// there.
///
/// Three things the concept asks for and this screen keeps:
///
///   - a block is a label and a budget, never a timetable — the rows
///     carry dwell times and walks, not clock times (§4.1);
///   - the hard times that *do* exist are shown as the frame they are,
///     above the blocks rather than inside them (§4.4);
///   - "Warum hier?" is one tap away on every spot. A plan nobody can
///     interrogate is a plan nobody trusts (§3.8).
struct TripPlanDayView: View {
    @State private var showSettings = false
    /// The itinerary, opened on the journey whose time a day shows.
    @State private var itineraryFocus: TripItineraryFocus?
    /// Which map app gets the handoff, when the traveller has not
    /// settled on one (§9.1).
    @State private var mapsChoice: TripMapsChoice?
    @AppStorage(TripMapsPreference.key) private var mapsPreference: String = TripMapsApp.apple.rawValue
    /// The stop whose "which block?" sheet is open, with the block it
    /// stands in now.
    @State private var moving: TripStopMove?
    /// Open while a hard time is being written (§4.4).
    @State private var addingFixpoint = false
    /// The spot the hard time is for, when it was opened from a spot
    /// ("Feste Zeit eintragen …").
    @State private var fixpointPreset: TripSpotChoice?
    /// The spot's fixed time being changed in that sheet, if it has one.
    @State private var editingFixpoint: TripFixpoint?
    /// The appointment whose spot is being chosen (§4.4).
    @State private var linkingFixpoint: TripFixpoint?
    @State private var settingDayAnchor = false
    /// The excursion whose sheet is open from its "⋯", if any.
    @State private var editingExcursion: TripExcursion?
    /// The block being split (§6.5), while its sheet is open.
    @State private var splitting: TripSplitTarget?
    /// A stay's planning view, pushed from the itinerary, which is where
    /// a trip opens (reise-planen-und-unterwegs-design.md, "Der
    /// Reiseverlauf"). A running trip pushes it at once, on today.
    @State private var showingStay = false
    @State private var openedRunningDay = false
    /// The spot picker (reise-planen-und-unterwegs.md, stage 4).
    @State private var pickingSpot = false
    /// The minute the screen is drawn for. Ticks while the day on
    /// screen is today, so "jetzt" moves along the blocks instead of
    /// staying on the one the screen was opened on — the first trial's
    /// complaint in one sentence.
    @State private var clock = Date()
    /// The day's offers: behind on a block, arrived late (§7.1).
    @State private var notices = TripDayNotices.shared
    @State var viewModel: TripPlannerViewModel

    var body: some View {
        Group {
            if viewModel.isLoading && viewModel.plan == nil {
                ProgressView("Plan wird geladen…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if viewModel.plan != nil {
                // Always the itinerary, also when the selected leg is a
                // journey: a journey is its sheet in the itinerary, not a
                // day screen of its own (Anton, 10.11.).
                itineraryRoot
            } else if let message = viewModel.errorMessage {
                ContentUnavailableView("Plan nicht verfügbar", systemImage: "map", description: Text(message))
            } else {
                ContentUnavailableView("Kein Plan", systemImage: "map")
            }
        }
        // The trip's own name first: it is what the plan list shows,
        // and a name typed into the settings that never appears on the
        // screen behind them is a name that looks lost. The leg is on
        // the picker above when there is more than one.
        .navigationTitle(screenTitle)
        .sheet(isPresented: $pickingSpot) {
            TripSpotPickerView(viewModel: viewModel)
        }
        .navigationDestination(isPresented: $showingStay) { stayRoot }
        .plannerErrorBanner(viewModel.errorMessage, retry: { await viewModel.load() }, dismiss: { viewModel.errorMessage = nil })
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if viewModel.day != nil, viewModel.leg != nil {
                ToolbarItem(placement: .topBarTrailing) {
                    // Only what belongs to the whole trip (§25). What
                    // belongs to the leg is behind its header, what
                    // belongs to the day is on the day.
                    Menu {
                        Button {
                            showSettings = true
                        } label: {
                            Label("Einstellungen", systemImage: "slider.horizontal.3")
                        }
                        Section("Gruppe") {
                            // Who may plan (§6.2) and who is coming
                            // (§3.5) are two questions; next to each
                            // other they at least read as two.
                            NavigationLink {
                                TripParticipantsView(planId: viewModel.planId)
                            } label: {
                                Label("Planen mit", systemImage: "person.2")
                            }
                            NavigationLink {
                                TripTravellersView(planId: viewModel.planId) {
                                    Task { await viewModel.load() }
                                }
                            } label: {
                                Label("Reisegruppe", systemImage: "figure.2.and.child.holdinghands")
                            }
                        }
                        Section("Rund um die Reise") {
                            NavigationLink {
                                TripDocumentsView(planId: viewModel.planId)
                            } label: {
                                Label("Dokumente", systemImage: "doc.text")
                            }
                            NavigationLink {
                                TripJournalView(planId: viewModel.planId) {
                                    Task { await viewModel.load() }
                                }
                            } label: {
                                Label("Änderungen", systemImage: "arrow.uturn.backward")
                            }
                            NavigationLink {
                                TripReadinessView(viewModel: viewModel)
                            } label: {
                                Label("Reisebereit?", systemImage: "checklist")
                            }
                            NavigationLink {
                                TripReviewView(planId: viewModel.planId)
                            } label: {
                                Label("Danach", systemImage: "clock.arrow.circlepath")
                            }
                            NavigationLink {
                                TripOfflineView(viewModel: viewModel)
                            } label: {
                                Label("Unterwegs ohne Netz", systemImage: "wifi.slash")
                            }
                        }
                    } label: {
                        Label("Reise", systemImage: "suitcase")
                    }
                }
            }
        }
        .confirmationDialog(
            "Navigation öffnen mit",
            isPresented: Binding(get: { mapsChoice != nil }, set: { if !$0 { mapsChoice = nil } }),
            titleVisibility: .visible,
        ) {
            if let choice = mapsChoice {
                Button("Apple Karten") { openMaps(choice, with: .apple) }
                Button("Google Maps") { openMaps(choice, with: .google) }
                // The setting was three screens away, in a tab about
                // something else. Here is where the decision is made.
                Button("Immer Apple Karten") {
                    mapsPreference = TripMapsApp.apple.rawValue
                    openMaps(choice, with: .apple)
                }
                Button("Immer Google Maps") {
                    mapsPreference = TripMapsApp.google.rawValue
                    openMaps(choice, with: .google)
                }
                Button("Abbrechen", role: .cancel) {}
            }
        }
        .sheet(item: $splitting) { target in
            TripSplitView(
                planId: viewModel.planId,
                dayIndex: viewModel.dayIndex,
                blockIndex: target.blockIndex,
                blockLabel: target.blockLabel,
                candidates: viewModel.leg?.pool ?? [],
            ) { Task { await viewModel.load() } }
        }
        .sheet(isPresented: $settingDayAnchor, onDismiss: { editingExcursion = nil }) {
            excursionSheet
        }
        .sheet(isPresented: $addingFixpoint, onDismiss: {
            fixpointPreset = nil
            editingFixpoint = nil
        }) {
            TripFixpointSheet(
                dayLabel: dayLabel(),
                spots: viewModel.leg?.spotChoices ?? [],
                presetSpot: fixpointPreset,
                existing: editingFixpoint,
                onRemove: editingFixpoint.map { fixed -> () async -> Void in { await viewModel.removeFixpoint(fixed) } },
            ) { draft in
                await viewModel.addFixpoint(draft)
            }
        }
        .sheet(item: $linkingFixpoint) { fix in
            TripFixpointSpotSheet(fixpoint: fix, spots: viewModel.leg?.spotChoices ?? []) { ref in
                await viewModel.setFixpointSpot(fix, spotRef: ref)
            }
        }
        .sheet(item: $moving) { move in
            NavigationStack {
                TripBlockPickerView(
                    title: move.stop.displayName,
                    leg: viewModel.leg,
                    current: (dayIndex: viewModel.dayIndex, blockId: move.blockId),
                    category: move.stop.category,
                ) { blockId, dayIndex in
                    await viewModel.move(move.stop, toDayIndex: dayIndex, toBlockId: blockId)
                }
            }
        }
        .sheet(item: $itineraryFocus, onDismiss: {
            // "Aufenthalt planen" in it: the planning view is already
            // the screen, on the stay it selected.
            viewModel.wantsStayPlan = false
        }) { focus in
            NavigationStack {
                TripItineraryView(viewModel: viewModel, focus: focus)
            }
        }
        .sheet(isPresented: $showSettings) {
            NavigationStack {
                TripPlanSettingsView(
                    planId: viewModel.planId,
                    constraints: viewModel.plan?.constraints,
                    title: viewModel.plan?.title,
                    // The date lives on the legs rather than in the
                    // constraints, so it is handed over separately.
                    startDate: viewModel.plan?.startDate,
                ) {
                    // Saving re-plans the days, so the screen behind has
                    // to be told rather than left showing the old ones.
                    Task { await viewModel.load() }
                }
            }
        }
        .task {
            await viewModel.load()
            openRunningDay()
            watchStops()
            runPendingReplan()
            // The banners need permission; asked on the trip, where a
            // "yes" means something, not in the planning month.
            if isTravelling { await notices.requestNotificationAuthorizationIfNeeded() }
            await viewModel.loadIdeasOfferQuietly()
            await viewModel.loadLight()
            await viewModel.loadForecast()
        }
        .task(id: viewModel.isToday) {
            // The screen's own minute, only on the day being lived:
            // the current block moves, and the day is asked whether
            // it has something to say (§7.1). Not a timer of the
            // day's — the phone keeps the clock; this only looks at it.
            guard viewModel.isToday else { return }
            while !Task.isCancelled {
                clock = Date()
                if let plan = viewModel.plan, isTravelling,
                   let running = TripRunningDay.of(plan: plan, light: viewModel.light, now: clock) {
                    notices.evaluate(running)
                    await notices.loadVisits(planId: plan.id)
                }
                try? await Task.sleep(for: .seconds(60))
            }
        }
        .onChange(of: notices.pendingReplan) { _, _ in runPendingReplan() }
        .onDisappear {
            // The fences belong to the trip, not to this screen: while
            // a trip runs they stay up so a Lock Screen and a background
            // wake still know where the group is. Off the trip they are
            // wake-ups that buy nothing.
            if !TripRunningPlan.shared.isTravelling { TripVisitMonitor.shared.stop() }
        }
        .onChange(of: viewModel.dayIndex) { _, _ in
            watchStops()
            // A different day is a different sun, and a different sky.
            Task {
                await viewModel.loadLight()
                await viewModel.loadForecast()
            }
        }
        .onChange(of: viewModel.legIndex) { _, _ in
            watchStops()
            Task {
                await viewModel.loadLight()
                await viewModel.loadForecast()
            }
        }
    }

    // MARK: - The stay and its days

    /// The trip opens on its itinerary: the stays with their days on one
    /// line, the journeys between them. A stay or one of its days opens
    /// the stay's planning view on top, so "Zurück" leads back here.
    private var itineraryRoot: some View {
        TripItineraryView(viewModel: viewModel, onPlan: { _, _ in showingStay = true })
            .onAppear {
                // "Neue Reise" asked for the itinerary, and this is it.
                viewModel.wantsItinerary = false
            }
    }

    /// While the trip runs it opens straight on the day being lived, in
    /// the planning view (design, "Unterwegs"): `apply` already chose
    /// that stay and day. Once per screen, so coming back to the
    /// itinerary stays there.
    private func openRunningDay() {
        guard !openedRunningDay, let plan = viewModel.plan else { return }
        openedRunningDay = true
        if plan.position(on: Date()) != nil, viewModel.leg?.isTransit == false {
            showingStay = true
        }
    }

    /// "Ausflug" for the selected day: a whole day elsewhere, or a time
    /// window inside the day (Mock 16). On a trip of ideas only the
    /// server cuts days into windows; elsewhere the sheet is whole days.
    @ViewBuilder
    private var excursionSheet: some View {
        let day = viewModel.day
        let dayIndex = viewModel.dayIndex
        let ideas = viewModel.plan?.isIdeasTrip ?? false
        let others = (day?.excursions ?? []).filter { $0.id != editingExcursion?.id }
        TripDayAnchorSheet(
            dayLabel: dayLabel(),
            current: editingExcursion == nil ? day?.anchor : nil,
            excursion: editingExcursion,
            allowsWholeDay: others.isEmpty,
            onSaveWindow: ideas ? saveWindow(day: day, dayIndex: dayIndex) : nil,
            onRemoveExcursion: editingExcursion.map { editing -> () async -> Void in
                { await viewModel.removeExcursion(editing, dayIndex: dayIndex) }
            },
        ) { draft in
            await viewModel.setDayAnchor(draft)
        }
    }

    private func saveWindow(day: TripDay?, dayIndex: Int) -> (TripPlannerViewModel.ExcursionDraft) async -> Bool {
        let editing = editingExcursion
        let replaces = day?.anchor != nil
        return { draft in
            if let editing {
                return await viewModel.updateExcursion(editing, draft, dayIndex: dayIndex)
            }
            return await viewModel.addExcursion(draft, dayIndex: dayIndex, replaceDayTrip: replaces)
        }
    }

    /// A stay opens as a whole, every day on one screen (stage 3).
    private var stayRoot: some View {
        TripStayPlanView(
            viewModel: viewModel,
            stopActions: { stop in stopActions(stop) },
            dayAction: { action, dayIndex in
                viewModel.select(dayIndex: dayIndex)
                switch action {
                case .order: Task { await viewModel.orderDay() }
                case .pause(let preset): Task { await viewModel.addBreak(label: preset.label, minutes: preset.minutes) }
                case .fixedTime: Self.afterMenu { addingFixpoint = true }
                case .dayTrip:
                    editingExcursion = nil
                    Self.afterMenu { settingDayAnchor = true }
                case .excursion(let excursion):
                    editingExcursion = excursion
                    Self.afterMenu { settingDayAnchor = true }
                }
            },
            // The stay's name heads the list in large; the bar only
            // carries the way back to the itinerary.
            title: "",
        )
    }

    /// Put geofences around the next stops of the day on screen (§7.1).
    ///
    /// Driven from the day view rather than started once at launch: the
    /// fences are only worth having around the day you are actually on,
    /// and re-deriving them when the day or leg changes is cheaper than
    /// keeping a second copy of "which day are we looking at".
    private func watchStops() {
        // While a trip runs the fences belong to today, not to the day
        // on screen: leafing through tomorrow must not take them off
        // the stops the group is walking to (§7.1). The day being lived
        // sets them itself (`TripVisitMonitor.follow`).
        if isTravelling {
            if viewModel.isToday, let plan = viewModel.plan,
               let running = TripRunningDay.of(plan: plan, light: viewModel.light, now: Date()) {
                TripVisitMonitor.shared.follow(running)
            }
            return
        }
        let stops = viewModel.stopsOfDay
        guard let leg = viewModel.leg, !stops.isEmpty || viewModel.isToday else {
            TripVisitMonitor.shared.stop()
            return
        }
        TripVisitMonitor.shared.watch(
            planId: viewModel.planId,
            dayIndex: viewModel.dayIndex,
            stops: stops,
            stopIdsByRef: Dictionary(stops.map { ($0.osmRef, $0.rowId) },
                                     uniquingKeysWith: { first, _ in first }),
            // The quarters too, on the day being lived: crossing that
            // fence is what the arrival day waits for (§5).
            quarters: viewModel.isToday
                ? TripGeofencePlan.anchorRegion(legId: leg.id, anchor: leg.anchor, radiusM: leg.anchorRadiusM)
                : nil,
        )
    }

    // MARK: - The frame

    /// "Tag 3 · Fr, 18.9." — which day the sheet is writing to, so a
    /// hard time never lands on a day nobody was looking at.
    private func dayLabel() -> String {
        let number = "Tag \(viewModel.dayIndex + 1)"
        guard let date = viewModel.leg?.date(ofDayIndex: viewModel.dayIndex) else { return number }
        return "\(number) · \(date)"
    }

    // MARK: - Block cards

    /// Where this block sits on the day — what the split call names it
    /// by, since a template id is not a position.
    private func blockIndex(of block: TripBlock) -> Int? {
        viewModel.day?.blocks.firstIndex { $0.id == block.id }
    }

    /// The fixpoint that frames this block, if any (§7.3).
    private func frame(of block: TripBlock) -> TripFixpoint? {
        viewModel.day?.fixpoints.first { $0.framesBlock && $0.blockId == block.id }
    }

    /// True for the stop a frame or a booked visit placed: it is at that
    /// hour because of the fixed time.
    /// The fixed time that holds this stop in place, if any (§4.4, §7.3).
    private func visit(of stop: TripStop) -> TripFixpoint? {
        dayHolding(stop)?.fixpoints.first { $0.holdsSpot && $0.spotRef == stop.osmRef }
    }

    /// The day of the leg on screen that holds this stop; the selected
    /// day when none does (a stop just moved, a list from elsewhere).
    private func dayHolding(_ stop: TripStop) -> TripDay? {
        viewModel.leg?.days.first { day in
            day.blocks.contains { block in block.stops.contains { $0.rowId == stop.rowId } }
        } ?? viewModel.day
    }

    /// Everything one can do with a planned stop — one list for every
    /// place a stop is shown: the row's menu, its long press, the detail
    /// screen and the map's sheet (§8.4). Out of the trial: the map could
    /// tick a stop off but not move it, the list could move it but not
    /// hide it, and what was possible depended on the way somebody had
    /// come. What differs is only what the stop's state allows.
    ///
    /// `later` runs what opens a screen of its own (the block picker)
    /// once the screen the action was pressed on has gone; the row's
    /// menu has nothing to wait for and runs it at once.
    private func stopActions(
        _ stop: TripStop,
        later: @escaping @MainActor (@escaping @MainActor () -> Void) -> Void = Self.afterMenu,
    ) -> [TripPinSheetAction] {
        let status = stop.stopStatus
        var actions: [TripPinSheetAction] = []
        // The stay's planning view shows every day at once, so the day
        // a stop is on is its own, not the one selected.
        let day = dayHolding(stop)
        let ideas = viewModel.plan?.isIdeasTrip == true
        let fixed = visit(of: stop)
        // Done or skipped only means something from the day itself on:
        // a spot next month cannot have been visited yet.
        let canSettle: Bool = {
            guard let leg = viewModel.leg, let day else { return isTravelling }
            let phase = TripOnTheRoad.phase(of: day.dayIndex, in: leg, today: TripCalendar.isoDay(Date()))
            return phase == .running || phase == .past || (phase == .undated && isTravelling)
        }()

        // The menu is the same in every state: what the state does not
        // allow is dimmed, not missing, so nobody wonders where an
        // action went (Anton, 10.11.; Apple's menus do the same).

        // Status first: it is what somebody standing at the place
        // reaches for.
        actions.append(TripPinSheetAction(id: "done", title: "Erledigt", systemImage: "checkmark",
                                          group: .status, disabled: status == .done || !canSettle) {
            await viewModel.mark(stop, as: .done)
        })
        actions.append(TripPinSheetAction(id: "skipped", title: "Übersprungen", systemImage: "xmark",
                                          group: .status, disabled: status == .skipped || !canSettle) {
            await viewModel.mark(stop, as: .skipped)
        })
        actions.append(TripPinSheetAction(id: "reopen", title: "Doch wieder offen",
                                          systemImage: "arrow.uturn.backward", group: .status,
                                          disabled: status == .planned) {
            await viewModel.mark(stop, as: .planned)
        })

        // Routing somewhere is only useful once you are travelling: a
        // route from home to a café you will walk to next month is a
        // number nobody wants.
        let mode = viewModel.leg?.transportMode ?? .foot
        actions.append(TripPinSheetAction(id: "route", title: "Route hierher",
                                          systemImage: "arrow.triangle.turn.up.right.circle",
                                          group: .navigate, disabled: !isTravelling) {
            later { offerMaps(.single(stop.coordinate, mode: mode)) }
        })
        actions.append(TripPinSheetAction(id: "showOnMap", title: "Auf der Karte zeigen",
                                          systemImage: "mappin.circle", closes: false, group: .navigate) {
            TripMapsOpen.pin(stop.coordinate, name: stop.name, using: TripMapsPreference.load())
        })

        // Not for a stop that is done (§5), not for one a fixed time
        // holds at its hour (the way is to take the time off), not on a
        // stay of one day: the server refuses each of them.
        let blockId = day?.blocks.first(where: { $0.stops.contains { $0.rowId == stop.rowId } })?.id
        let canMove = status != .done && fixed == nil && (viewModel.leg?.days.count ?? 0) > 1 && blockId != nil
        actions.append(TripPinSheetAction(id: "move", title: "Auf einen anderen Tag",
                                          systemImage: "calendar", disabled: !canMove) {
            guard let day, let blockId else { return }
            later {
                viewModel.select(dayIndex: day.dayIndex)
                moving = TripStopMove(stop: stop, blockId: blockId)
            }
        })
        // A ticket for this spot (§4.4): the spot then stands at that
        // hour, and on no other day. One entry, "Feste Zeit …" (Anton,
        // 10.11.): its sheet enters a time with its reason, or changes
        // the one there is, or takes it off.
        actions.append(TripPinSheetAction(id: "appointment", title: "Feste Zeit …",
                                          systemImage: fixed == nil ? "calendar.badge.clock" : "calendar.badge.checkmark",
                                          disabled: status != .planned && fixed == nil) {
            later {
                if let day { viewModel.select(dayIndex: day.dayIndex) }
                fixpointPreset = TripSpotChoice(osmRef: stop.osmRef, name: stop.displayName, plannedOn: nil)
                editingFixpoint = fixed
                addingFixpoint = true
            }
        })
        // Holding a stop in its slot when the planner plans again: a
        // trip of ideas never plans again, and there "gepinnt" is a
        // fixed time.
        if !ideas {
            actions.append(TripPinSheetAction(id: "pin",
                                              title: stop.pinned ? "Nicht mehr anheften" : "Anheften",
                                              systemImage: stop.pinned ? "pin.slash" : "pin") {
                await viewModel.setPinned(stop, !stop.pinned)
            })
        }
        // "Löschen", at the bottom as on every list (Anton, 10.11.): the
        // card leaves the day and goes back to the ideas of the stay, so
        // nothing is lost. A fixed time holding it comes off first.
        actions.append(TripPinSheetAction(
            id: "delete", title: "Löschen", systemImage: "trash", role: .destructive,
            footer: ideas
                ? "Er verlässt den Tag und bleibt bei den Ideen des Aufenthalts."
                : "„Nicht heute“ — er bleibt im Rennen und kommt beim nächsten Planen wieder in Frage.",
            group: .remove, disabled: status != .planned,
        ) {
            if let fixed {
                await viewModel.removeFixpoint(fixed)
                let again = viewModel.leg?.days
                    .flatMap { $0.blocks.flatMap(\.stops) }
                    .first { $0.osmRef == stop.osmRef }
                if let again { await viewModel.returnToPool(again) }
            } else {
                await viewModel.returnToPool(stop)
            }
        })
        // On a day the card only leaves the day: keeping it for another
        // trip and taking it out of the trip are actions of an idea, in
        // the spot picker (Anton, 10.11.).
        if !ideas {
            actions.append(TripPinSheetAction(
                id: "hide", title: "Für diese Reise ausblenden", systemImage: "eye.slash",
                role: .destructive,
                footer: "Der Planer schlägt ihn auf dieser Reise nicht mehr vor, auch beim nächsten "
                    + "Neuplanen nicht.",
                group: .remove,
            ) {
                await viewModel.hide(osmRef: stop.osmRef)
            })
        }
        // How much it matters (ideas plan, stage 3), while the stop is
        // still to come.
        if ideas {
            actions.append(contentsOf: TripIdeaPriority.actions(current: stop.ideaPriority) { priority in
                await viewModel.setPriority(osmRef: stop.osmRef, priority)
            }.map { action in
                var action = action
                action.disabled = action.disabled || status != .planned
                return action
            })
        }
        return actions
    }

    /// A sheet opened from a menu item waits for the menu to finish
    /// closing: presented at once, UIKit drops it while the menu is
    /// still on its way out, and the item seemed to need a second tap.
    private static func afterMenu(_ open: @escaping @MainActor () -> Void) {
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(350))
            open()
        }
    }

    // MARK: - While you are out

    /// "Umplanen" pressed on a notification while this screen was not
    /// up: carried out here, once the plan is loaded, on the day the
    /// notification was about.
    private func runPendingReplan() {
        guard let pending = notices.pendingReplan,
              pending.planId == viewModel.planId,
              viewModel.plan != nil
        else { return }
        notices.pendingReplan = nil
        viewModel.goToToday()
        Task {
            await viewModel.redistributeNow(arrivedLate: pending.arrivedLate)
            if viewModel.redistributeBlockedReason == nil { notices.clearAfterReplan() }
        }
    }

    /// The trip's name, else the leg's, else a plain word.
    private var screenTitle: String {
        if let title = viewModel.plan?.title, !title.isEmpty { return title }
        if let title = viewModel.leg?.title, !title.isEmpty { return title }
        return "Plan"
    }

    /// On the trip by either reckoning — trip mode on, or a planned
    /// day whose date is today (`TripRunningPlan.isTravelling`).
    private var isTravelling: Bool { TripRunningPlan.shared.isTravelling }

    private func offerMaps(_ choice: TripMapsChoice) {
        let availability = TripMapsAvailability(
            preference: TripMapsApp(rawValue: mapsPreference) ?? .apple,
            googleAppInstalled: TripMapsOpen.googleInstalled,
        )
        if let app = availability.resolved {
            TripMapsOpen.route(choice, using: app)
        } else {
            mapsChoice = choice
        }
    }

    private func openMaps(_ choice: TripMapsChoice, with app: TripMapsApp) {
        mapsChoice = nil
        TripMapsOpen.route(choice, using: app)
    }
}

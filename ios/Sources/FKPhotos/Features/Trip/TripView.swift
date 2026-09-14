import Photos
import SwiftUI

/// Entry point of the "Trip" tab: two halves of the same trip (§8.1).
///
/// **Aufnehmen** is trip mode — Lebenszyklus (starten/beenden), Modus-
/// und Auto/Manuell-Optionen und das Foto-Grid des Trip-Albums.
/// Ortsermittlung beim Start liefert den Namensvorschlag, der
/// automatische Foto-Zuwachs läuft über den Auto-Add-Pass (siehe
/// `docs/ios-trip-mode.md`). **Planen** is the vacation planner
/// (`TripPlansListView`). A segmented control in the navigation bar
/// switches; the planner used to hang on one toolbar icon here, four
/// levels from the tab to a day.
struct TripView: View {
    @State private var store = TripStore.shared
    @State private var autoStart = TripAutoStartMonitor.shared
    @Environment(\.scenePhase) private var scenePhase
    @State private var showStartSheet = false
    /// Prefill handed to `TripStartSheet`. Set from the auto-start suggestion,
    /// `nil` for a manual start.
    @State private var startSheetName: String?
    @State private var errorMessage: String?
    @State private var showError = false
    /// A planned trip (§8.1) whose dates say it is happening today.
    /// Held centrally so the tab bar and this screen share one answer
    /// (`TripRunningPlan`).
    @State private var running = TripRunningPlan.shared
    /// The plan the traveller asked to open — from the "läuft heute"
    /// banner on the capture half, or from the list on the planning
    /// half. One destination for both, held here, because two in the
    /// same stack for the same type would leave one dead. The banner
    /// stays; it used to auto-push the day screen once per launch,
    /// which made the same tap lead somewhere else the second time
    /// (§8.5).
    @State private var openPlanId: Int?
    /// Which half is showing. Stored, so the traveller comes back to
    /// the half they left; decided once per appearance from what is
    /// happening (`TripTabMode.initial`).
    @AppStorage("trip.tab.mode") private var mode: TripTabMode = .capture
    @State private var didChooseMode = false
    /// "Das hier merken" from the tab itself (plan item E3): one tap,
    /// where the collection used to be two screens away. The view model
    /// is only ever asked to add; the list it also holds is not shown here.
    @State private var ideas = TripIdeasViewModel()
    @State private var isAddingHere = false
    /// The sentence the server answered the last capture with, shown
    /// once so the tap is seen to have done something.
    @State private var lastCapture: String?
    @State private var captureRequest = TripIdeaCaptureRequest.shared

    var body: some View {
        Group {
            switch mode {
            case .capture:
                captureHalf
            case .plan:
                TripPlansListView(openPlanId: $openPlanId)
            }
        }
        .navigationTitle("Trip")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            // The two halves are peers (§8.1): one is the trip you are
            // on, the other the trip you are planning, and the tab bar
            // is full. So they share the tab and the switch sits where
            // the title would.
            ToolbarItem(placement: .principal) {
                Picker("Bereich", selection: $mode) {
                    ForEach(TripTabMode.allCases, id: \.self) { half in
                        Text(half.title).tag(half)
                    }
                }
                .pickerStyle(.segmented)
                .frame(maxWidth: 240)
            }
            if mode == .capture {
                ToolbarItem(placement: .topBarLeading) {
                    NavigationLink {
                        TripSettingsView()
                    } label: {
                        Label("Einstellungen", systemImage: "gearshape")
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        isAddingHere = true
                    } label: {
                        Label("Das hier merken", systemImage: "mappin.and.ellipse")
                    }
                }
            }
        }
        .sheet(isPresented: $isAddingHere) {
            TripIdeaCaptureSheet(
                title: "Das hier merken",
                explanation: "Gespeichert wird, wo ihr gerade steht — in den Ideen.",
            ) { note, dwellMinutes in
                await ideas.addHere(note: note, dwellMinutes: dwellMinutes)
                if ideas.errorMessage == nil { lastCapture = ideas.lastAddition }
                return ideas.errorMessage == nil
            }
        }
        .onChange(of: captureRequest.isRequested) { _, requested in
            if requested { consumeCaptureRequest() }
        }
        .sheet(isPresented: $showStartSheet) {
            TripStartSheet(suggestedName: startSheetName) { name in
                Task { await start(name: name) }
            }
        }
        .alert("Fehler", isPresented: $showError) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(errorMessage ?? "")
        }
        .navigationDestination(item: $openPlanId) { planId in
            TripPlanDayView(viewModel: TripPlannerViewModel.shared(for: planId))
        }
        .onAppear { consumeStartSuggestionHandoff() }
        .task {
            await loadRunningPlan()
            chooseModeOnce()
            consumeCaptureRequest()
        }
        .onChange(of: scenePhase) { _, newPhase in
            if newPhase == .active {
                consumeStartSuggestionHandoff()
                Task { await loadRunningPlan() }
            }
        }
    }

    /// Is one of the planned trips happening today?
    ///
    /// Answered from the dates rather than from anything anybody
    /// pressed. A "start" button would have to be pressed on the one
    /// morning nobody has their phone out, and it would be wrong the
    /// moment a flight moved. The answer is shown as a banner and
    /// never acted on by itself: a screen that moves under the thumb
    /// is worse than one more tap.
    @MainActor
    private func loadRunningPlan() async {
        await running.refresh()
    }

    /// Trip mode as it was before the planner moved in beside it.
    @ViewBuilder private var captureHalf: some View {
        VStack(spacing: 0) {
            if let lastCapture {
                HStack(spacing: 12) {
                    Image(systemName: "checkmark.circle").foregroundStyle(.secondary)
                    Text(lastCapture).font(.footnote)
                    Spacer()
                    Button("OK") { self.lastCapture = nil }.font(.footnote)
                }
                .padding(.horizontal)
                .padding(.vertical, 8)
                .background(.thinMaterial)
                Divider()
            }
            if let trip = store.activeTrip {
                ActiveTripView(trip: trip, store: store, runningPlan: running.plan) { planId in
                    openPlanId = planId
                }
            } else {
                noTripView
            }
        }
    }

    /// The App Shortcut asked for "Das hier merken": show the half that
    /// has the button, and open the sheet. Taken once, whichever of the
    /// two observers gets there first.
    @MainActor
    private func consumeCaptureRequest() {
        guard captureRequest.consume() else { return }
        mode = .capture
        isAddingHere = true
    }

    /// Which half to show, decided once per appearance of the tab —
    /// after the running plan is known, because that is one of the two
    /// things it depends on. Re-deciding on every refresh would move
    /// the screen under somebody's thumb.
    @MainActor
    private func chooseModeOnce() {
        guard !didChooseMode else { return }
        didChooseMode = true
        mode = TripTabMode.initial(
            tripModeActive: store.isActive,
            planRunningToday: running.plan != nil,
            remembered: mode,
        )
    }

    /// Opens the prefilled start sheet when the user chose "Trip starten" on
    /// the suggestion notification. That action deliberately doesn't start the
    /// trip itself — the name becomes an iOS *and* a server album, so it wants
    /// confirming (`docs/ios-trip-mode.md` §9.2).
    @MainActor
    private func consumeStartSuggestionHandoff() {
        guard !store.isActive, let name = autoStart.consumeStartSheetRequest() else { return }
        startSheetName = name
        showStartSheet = true
    }

    @ViewBuilder private var noTripView: some View {
        VStack(spacing: 0) {
            // One banner, whatever is known. When the photos say
            // "unterwegs" and the dates say which trip, the trip name
            // is the prefill — not the geocoded place the photos were
            // taken at.
            if let suggestion = autoStart.pendingSuggestion {
                autoStartBanner(suggestion, plan: running.plan)
                Divider()
            } else if let runningPlan = running.plan {
                plannedTripBanner(runningPlan)
                Divider()
            }
            if let closed = store.closedTrips.last {
                gracePeriodLine(closed)
                Divider()
            }
            ContentUnavailableView {
                Label("Kein aktiver Trip", systemImage: "map")
            } description: {
                Text("Starte einen Trip, damit neue Fotos automatisch in ein gemeinsames Trip-Album synchronisiert werden – ohne vorher ein Album anzulegen.")
            } actions: {
                Button("Trip starten") {
                    startSheetName = nil
                    showStartSheet = true
                }
                .buttonStyle(.borderedProminent)
                .disabled(store.isProvisioning)
            }
        }
    }

    /// The planned trip is happening today, and trip mode is not on.
    ///
    /// The two "Reise" halves are separate on purpose — you plan months
    /// ahead and you photograph on the day — but nothing connected them,
    /// so a traveller standing on Marienplatz with a planned Munich trip
    /// saw no sign of it. This is that connection, and it is an offer
    /// rather than an automatism: starting trip mode creates an album,
    /// which is not something to do behind somebody's back.
    @MainActor
    private func plannedTripBanner(_ plan: TripPlanSummary) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 12) {
                Image(systemName: "calendar.badge.clock")
                    .foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text("„\(plan.displayTitle)“ läuft heute")
                        .font(.subheadline.weight(.semibold))
                    Text(plan.schedule(on: Date()).label)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
            }
            HStack(spacing: 8) {
                Button("Trip starten") {
                    startSheetName = plan.displayTitle
                    showStartSheet = true
                }
                .buttonStyle(.borderedProminent)
                Button("Plan öffnen") { openPlanId = plan.id }
                    .buttonStyle(.bordered)
                Spacer()
            }
        }
        .padding()
        .background(.thinMaterial)
    }

    /// A trip was ended, and its album is still catching up (§14.6).
    ///
    /// For a day after "Beenden" late photos still land in the album
    /// and no new start is suggested. Both were invisible: the tab said
    /// "Kein aktiver Trip" and behaved as if it were not quite true.
    @MainActor
    private func gracePeriodLine(_ trip: ActiveTrip) -> some View {
        HStack(spacing: 12) {
            Image(systemName: "clock.arrow.circlepath")
                .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text("„\(trip.name)“ wurde beendet")
                    .font(.subheadline.weight(.semibold))
                Text("Nachzügler-Fotos werden noch bis morgen ergänzt. Bis dahin wird kein neuer Trip vorgeschlagen.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding()
        .background(.thinMaterial)
    }

    /// Fallback for the auto-start suggestion when the notification was denied,
    /// missed or ignored — the mirror of `ActiveTripView`'s auto-end banner.
    ///
    /// - Parameter plan: the planned trip running today, if any. Its
    ///   title wins over the geocoded name: the album should be called
    ///   what the trip is called.
    @MainActor
    private func autoStartBanner(_ suggestion: PendingStartSuggestion,
                                 plan: TripPlanSummary?) -> some View {
        let name = plan?.displayTitle ?? suggestion.suggestedName
        return VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 12) {
                Image(systemName: "airplane.departure")
                    .foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(plan == nil
                         ? "Sieht aus, als wärst du unterwegs"
                         : "„\(name)“ läuft heute – und du bist unterwegs")
                        .font(.subheadline.weight(.semibold))
                    Text("\(suggestion.suggestedName) – seit \(suggestion.travellingSince.formatted(date: .abbreviated, time: .shortened))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
            }
            HStack(spacing: 8) {
                Button("Trip starten") {
                    startSheetName = name
                    autoStart.dismissSuggestion()
                    showStartSheet = true
                }
                .buttonStyle(.borderedProminent)
                if let plan {
                    Button("Plan öffnen") { openPlanId = plan.id }
                        .buttonStyle(.bordered)
                }
                Button("Nicht jetzt") { autoStart.dismissSuggestion() }
                    .buttonStyle(.bordered)
                Spacer()
                // Same words as the notification action, and honest
                // about the reach: a grid cell of a few kilometres, not
                // the whole app.
                Button("In dieser Gegend nicht mehr fragen") { autoStart.suppressCurrentRegion() }
                    .buttonStyle(.borderless)
                    .font(.caption)
            }
        }
        .padding()
        .background(.thinMaterial)
    }

    private func start(name: String) async {
        // Read-write access is required to create the iOS album.
        let status = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
        guard status == .authorized || status == .limited else {
            errorMessage = "Bitte erlaube den Zugriff auf die Fotos, um einen Trip zu starten."
            showError = true
            return
        }
        do {
            try await store.startTrip(name: name)
        } catch {
            errorMessage = TripErrorText.describe(error)
            showError = true
        }
    }
}

// MARK: - Active trip

private struct ActiveTripView: View {
    let trip: ActiveTrip
    let store: TripStore
    /// The planned trip whose dates say it is today, so the plan is one
    /// tap away while the photos are being taken — not four screens.
    let runningPlan: TripPlanSummary?
    let onOpenPlan: (Int) -> Void

    @Environment(\.scenePhase) private var scenePhase
    @State private var assets: [PHAsset] = []
    @State private var isLoading = true
    @State private var showEndConfirm = false
    @State private var showShareSheet = false
    /// The auto-end monitor, observed: its suggestion for this trip is the
    /// banner below. The suggestion is normally raised and answered via the
    /// notification while the app isn't running, so the banner is the
    /// fallback for when notifications are denied or the user opens the app
    /// instead of using the notification's actions — and the same value
    /// puts the dot on the tab (§2.1).
    @State private var autoEnd = TripAutoEndMonitor.shared

    private var autoEndSuggestion: PendingAutoEndSuggestion? {
        let pending = autoEnd.pendingSuggestion
        return pending?.tripIosAlbumId == trip.iosAlbumId ? pending : nil
    }
    /// A sync mode waiting for the confirmation below.
    @State private var pendingMode: PhotoSyncMode?

    private let columns = [GridItem(.adaptive(minimum: 100, maximum: 150), spacing: 2)]

    var body: some View {
        VStack(spacing: 0) {
            if autoEndSuggestion != nil {
                autoEndBanner
                Divider()
            }
            if let runningPlan {
                runningPlanBanner(runningPlan)
                Divider()
            }
            optionsBar
            Divider()
            grid
        }
        // Re-keyed on the auto-add pass's progress marker so the grid refreshes
        // after new trip photos were added (the parent re-renders with an
        // updated trip). The watermark moves on every pass that saw something
        // new; the edge count covers the rare pass that added a photo sitting on
        // the watermark instant itself.
        .task(id: """
            \(trip.iosAlbumId)-\
            \(trip.handledWatermark?.timeIntervalSince1970 ?? 0)-\
            \(trip.handledAssetIds.count)
            """) {
            assets = await Self.loadAssets(albumId: trip.iosAlbumId)
            isLoading = false
        }
        .confirmationDialog(
            "Trip beenden?",
            isPresented: $showEndConfirm,
            titleVisibility: .visible
        ) {
            Button("Trip beenden", role: .destructive) { store.endTrip() }
            Button("Abbrechen", role: .cancel) {}
        } message: {
            Text("Neue Fotos werden nicht mehr automatisch hinzugefügt. Das Album und die bereits synchronisierten Fotos bleiben erhalten.")
        }
        // Sharing the trip album straight from the trip view (issue #918): the
        // trip syncs into an ordinary server album, so the regular album share
        // UI applies unchanged.
        .sheet(isPresented: $showShareSheet) {
            AlbumShareView(albumId: trip.serverAlbumId, albumName: trip.name)
        }
        .onAppear { autoEnd.reloadPendingSuggestion() }
        .onChange(of: scenePhase) { _, newPhase in
            // The notification's actions may have run in another process
            // while this one was in the background.
            if newPhase == .active { autoEnd.reloadPendingSuggestion() }
        }
        .confirmationDialog(
            "Löschungen übernehmen?",
            isPresented: Binding(get: { pendingMode != nil }, set: { if !$0 { pendingMode = nil } }),
            titleVisibility: .visible,
        ) {
            if let pendingMode {
                Button(pendingMode == .sync ? "Synchronisieren" : "Zwei-Wege") {
                    store.setMode(pendingMode)
                    self.pendingMode = nil
                }
                Button("Abbrechen", role: .cancel) { self.pendingMode = nil }
            }
        } message: {
            Text(Self.modeHint(pendingMode ?? .sync))
        }
    }

    /// The plan behind the photos, while both are happening (§3.7).
    @MainActor
    private func runningPlanBanner(_ plan: TripPlanSummary) -> some View {
        HStack(spacing: 12) {
            Image(systemName: "calendar.badge.clock")
                .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text("„\(plan.displayTitle)“ läuft heute")
                    .font(.subheadline.weight(.semibold))
                Text(plan.schedule(on: Date()).label)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button("Plan öffnen") { onOpenPlan(plan.id) }
                .buttonStyle(.bordered)
        }
        .padding()
        .background(.thinMaterial)
    }

    private var autoEndBanner: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 12) {
                Image(systemName: "house.fill")
                    .foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Bist du zurück?")
                        .font(.subheadline.weight(.semibold))
                    Text("Sieht so aus, als wärst du wieder zuhause.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
            }
            HStack(spacing: 8) {
                // Same words as the notification's actions, and the
                // same confirmation as the toolbar's "Beenden": ending
                // a trip from a banner is not a smaller decision than
                // ending it from a button.
                Button("Trip beenden") {
                    autoEnd.dismissSuggestion(forTripAlbumId: trip.iosAlbumId)
                    showEndConfirm = true
                }
                .buttonStyle(.borderedProminent)
                Button("Weiter unterwegs") {
                    autoEnd.dismissSuggestion(forTripAlbumId: trip.iosAlbumId)
                }
                .buttonStyle(.bordered)
                Spacer()
            }
        }
        .padding()
        .background(.thinMaterial)
    }

    private var optionsBar: some View {
        VStack(spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(trip.name)
                        .font(.headline)
                    Text("seit \(trip.startedAt.formatted(date: .abbreviated, time: .shortened))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button { showShareSheet = true } label: {
                    Label("Teilen", systemImage: "person.crop.circle.badge.plus")
                        .labelStyle(.titleAndIcon)
                }
                .buttonStyle(.bordered)
                Button(role: .destructive) { showEndConfirm = true } label: {
                    Text("Beenden")
                }
                .buttonStyle(.bordered)
            }

            // What the chosen mode does, in one line under the picker.
            // "Zwei-Wege" is not a word anybody brings to a holiday.
            Text(Self.modeHint(trip.mode))
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)

            HStack {
                Picker("Modus", selection: Binding(
                    get: { trip.mode },
                    set: { chosen in
                        // Kopieren → Synchronisieren makes a deletion on
                        // the phone a deletion in a possibly shared
                        // album. Once, asked.
                        if chosen != .copy, trip.mode == .copy {
                            pendingMode = chosen
                        } else {
                            store.setMode(chosen)
                        }
                    }
                )) {
                    Text("Kopieren").tag(PhotoSyncMode.copy)
                    Text("Synchronisieren").tag(PhotoSyncMode.sync)
                    Text("Zwei-Wege").tag(PhotoSyncMode.bisync)
                }
                .pickerStyle(.menu)
                .accessibilityHint(Self.modeHint(trip.mode))

                Spacer()

                Text(trip.autoAdd ? "Automatisch" : "Manuell")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                Toggle("Neue Fotos automatisch ins Album legen", isOn: Binding(
                    get: { trip.autoAdd },
                    set: { store.setAutoAdd($0) }
                ))
                .labelsHidden()
                .accessibilityHint(Self.autoAddHint(trip.autoAdd, albumName: trip.name))
            }

            // The switch decides one thing only: whether new photos are
            // put into the iOS album by themselves. The album is synced
            // to the server either way — "Manuell" is not "aus".
            Text(Self.autoAddHint(trip.autoAdd, albumName: trip.name))
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding()
    }

    /// One sentence for the auto-add switch, for the caption under it.
    static func autoAddHint(_ autoAdd: Bool, albumName: String) -> String {
        TripAutoAddCaption.hint(autoAdd: autoAdd, albumName: albumName)
    }

    /// One sentence per sync mode, for the picker's caption.
    static func modeHint(_ mode: PhotoSyncMode) -> String {
        switch mode {
        case .copy:
            return "Kopieren: Neue Fotos gehen ins Album. Was du auf dem iPhone löschst, bleibt dort."
        case .sync:
            return "Synchronisieren: Was du auf dem iPhone löschst, verschwindet auch im Album."
        case .bisync:
            return "Zwei-Wege: Änderungen in beide Richtungen – auch Löschungen anderer landen auf dem iPhone."
        }
    }

    @ViewBuilder private var grid: some View {
        if isLoading {
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if assets.isEmpty {
            ContentUnavailableView {
                Label("Noch keine Trip-Fotos", systemImage: "photo")
            } description: {
                Text(trip.autoAdd
                     ? "Neue Fotos, die du jetzt aufnimmst, landen von selbst hier und im f4mil-Album."
                     : "Im manuellen Modus kommt kein Foto von selbst dazu. Das Album wird trotzdem synchronisiert: Lege Fotos in der Fotos-App in das Album „\(trip.name)“, dann landen sie im f4mil-Album.")
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ScrollView {
                LazyVGrid(columns: columns, spacing: 2) {
                    ForEach(assets, id: \.localIdentifier) { asset in
                        LibraryPhotoCell(asset: asset)
                    }
                }
                .padding(.horizontal, 2)
            }
        }
    }

    /// Loads the trip album's image assets (newest first). Returns an empty
    /// array when the collection can't be resolved.
    private static func loadAssets(albumId: String) async -> [PHAsset] {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                let collections = PHAssetCollection.fetchAssetCollections(
                    withLocalIdentifiers: [albumId], options: nil
                )
                guard let collection = collections.firstObject else {
                    continuation.resume(returning: [])
                    return
                }
                let options = PHFetchOptions()
                options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
                options.predicate = NSPredicate(format: "mediaType == %d", PHAssetMediaType.image.rawValue)
                var list: [PHAsset] = []
                PHAsset.fetchAssets(in: collection, options: options).enumerateObjects { asset, _, _ in
                    list.append(asset)
                }
                continuation.resume(returning: list)
            }
        }
    }
}

/// The caption under the Auto/Manuell switch (`docs/ios-trip-mode.md` §7).
///
/// Both halves say the same second thing on purpose: the switch changes
/// how photos get *into* the iOS album, never whether the album is
/// synchronised. Read as "Manuell = nichts passiert", it was being
/// switched off by people who wanted the opposite. Its own type so the
/// wording is testable outside the private view.
enum TripAutoAddCaption {
    static func hint(autoAdd: Bool, albumName: String) -> String {
        if autoAdd {
            return "Automatisch: Neue Fotos landen von selbst im iOS-Album „\(albumName)“ und werden von dort ins f4mil-Album synchronisiert."
        }
        return "Manuell: Neue Fotos bleiben in der Aufnahmen-Ansicht. Was du selbst ins iOS-Album „\(albumName)“ legst, wird ins f4mil-Album synchronisiert – auch wenn es bis dahin leer bleibt."
    }
}

import SwiftUI

/// The cities of a trip, after it exists (§4.2, §6.2).
///
/// A trip has been a list of legs since the first line of the planner —
/// each with its own anchor, its own way of getting around and its own
/// pool — but the app could only ever create one of them, and never
/// change it afterwards. So the twenty-day trip through Japan the
/// concept walks through (§16) was, in the app, one city forever.
///
/// This is the screen that was missing. It is deliberately a **list of
/// equals**: the first city is not special here, because after the trip
/// exists it is not — the hotel in Tokyo changes exactly as the hotel in
/// Osaka does.
///
/// Two things it says out loud rather than discovering later. Removing a
/// city takes its days *and its pool* with it, including whatever
/// somebody researched and added by hand (§9.2) — so it asks. And
/// anything that moves the frame is the organiser's alone (§6.2); a
/// companion sees the route and gets the server's refusal in words
/// rather than a screen that half works.
struct TripLegsView: View {
    @State var viewModel: TripPlannerViewModel

    @State private var adding = false
    @State private var removing: TripLeg?
    /// The city whose editor is open — a sheet with Abbrechen/Sichern,
    /// like every other editor, instead of a push where Back discarded.
    @State private var editing: TripLeg?
    /// The journey being added or changed (§22.7): after which leg, and
    /// the journey itself when it exists.
    @State private var transit: TransitTarget?

    /// The one journey the planner would suggest (§22.7), or nil.
    @State private var suggestion: TripTransitSuggestion?
    /// Looking for where home is (§22.7).
    @State private var homeFinder = TripPlaceFinderModel()
    /// Where they live, for a trip made before it was known.
    @State private var userHome: TripHome?
    @State private var savingHome = false

    private struct TransitTarget: Identifiable {
        let afterLegIndex: Int
        let existing: TripLeg?
        var suggested: TripTransitSuggestion? = nil
        var id: String { "\(afterLegIndex)-\(existing?.id ?? 0)" }
    }
    @State private var isWorking = false
    @State private var errorMessage: String?

    var body: some View {
        List {
            if let suggestion {
                Section {
                    Label(suggestion.sentence, systemImage: "arrow.triangle.turn.up.right.diamond")
                        .font(.subheadline)
                    HStack {
                        Button("Ansehen") {
                            transit = TransitTarget(afterLegIndex: suggestion.afterLegIndex,
                                                    existing: nil, suggested: suggestion)
                        }
                        .buttonStyle(.borderedProminent)
                        Button("Nein") { dismissSuggestion(suggestion) }
                            .buttonStyle(.bordered)
                    }
                    .controlSize(.small)
                }
            }
            Section {
                // Where the trip sets off from and returns to: with it,
                // the way there and the way home are journeys too.
                if let home = viewModel.plan?.home {
                    HStack {
                        Label(home.displayLabel, systemImage: "house")
                        Spacer()
                        Button("Entfernen") { Task { await clearHome() } }
                            .buttonStyle(.borderless)
                            .disabled(savingHome)
                    }
                } else {
                    // Where they live, said once in the settings: one
                    // tap, not a search, for the trip that was made
                    // before it was known.
                    if let mine = userHome {
                        Button {
                            Task { await setHome(TripPlace(name: mine.displayLabel, subtitle: nil,
                                                           latitude: mine.lat, longitude: mine.lon)) }
                        } label: {
                            Label("„\(mine.displayLabel)“ übernehmen", systemImage: "house")
                        }
                        .disabled(savingHome)
                    }
                    TripPlaceFinderRows(model: homeFinder, picked: nil) { place in
                        homeFinder.clearResults()
                        Task { await setHome(place) }
                    }
                }
            } header: {
                Text("Zuhause")
            } footer: {
                Text("Von hier geht es los, und hierher zurück. Mit einem Zuhause lassen sich "
                     + "Anreise und Heimreise wie eine Weiterreise planen — mit Orten am Weg. "
                     + "Wo du wohnst, sagst du einmal in den Einstellungen; jede neue Reise "
                     + "beginnt damit.")
            }

            Section {
                if let legs = viewModel.plan?.legs, TripTransitSlots.wantsArrival(legs, hasHome: viewModel.plan?.home != nil) {
                    journeyButton("Anreise einfügen", systemImage: "house.and.flag", afterLegIndex: -1)
                }
                ForEach(viewModel.plan?.legs.sorted(by: { $0.position < $1.position }) ?? []) { leg in
                    Button {
                        if leg.isTransit {
                            transit = TransitTarget(afterLegIndex: leg.position - 1, existing: leg)
                        } else {
                            editing = leg
                        }
                    } label: {
                        HStack {
                            row(leg)
                            Spacer()
                            Image(systemName: "chevron.right")
                                .font(.caption)
                                .foregroundStyle(.tertiary)
                        }
                        .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .swipeActions(edge: .trailing) {
                        Button(role: .destructive) { removing = leg } label: {
                            Label("Entfernen", systemImage: "trash")
                        }
                    }
                    // Adding is a button; removing was a swipe nobody
                    // finds. A long press is the second way in.
                    .contextMenu {
                        Button(role: .destructive) { removing = leg } label: {
                            Label(leg.isTransit ? "Weiterreise entfernen" : "Stadt entfernen",
                                  systemImage: "trash")
                        }
                    }
                    // Between two places without a journey yet: the way
                    // to say when the group leaves and when it arrives.
                    if let after = TripTransitSlots.slotAfter(leg, in: viewModel.plan?.legs ?? []) {
                        journeyButton("Weiterreise einfügen", systemImage: "arrow.triangle.turn.up.right.diamond",
                                      afterLegIndex: after)
                    }
                }
                if let legs = viewModel.plan?.legs,
                   let last = TripTransitSlots.wantsReturn(legs, hasHome: viewModel.plan?.home != nil) {
                    journeyButton("Heimreise einfügen", systemImage: "house", afterLegIndex: last)
                }
            } footer: {
                Text("Jede Stadt hat ihren eigenen Ausgangspunkt, ihr eigenes Verkehrsmittel "
                     + "und ihre eigenen Kandidaten. Umverteilt wird immer nur innerhalb einer "
                     + "Stadt — was in Tokio nicht mehr passt, rutscht nicht nach Osaka.")
            }

            Section {
                Button {
                    adding = true
                } label: {
                    Label("Stadt hinzufügen", systemImage: "plus.circle")
                }
                .disabled(isWorking || (viewModel.plan?.legs.count ?? 0) >= TripNewPlanDraft.maxLegs)
            }

        }
        .navigationTitle("Städte")
        .plannerErrorBanner(errorMessage, dismiss: { errorMessage = nil })
        .navigationBarTitleDisplayMode(.inline)
        .sheet(item: $editing) { leg in
            NavigationStack {
                TripLegEditView(viewModel: viewModel, legIndex: leg.position)
            }
        }
        .sheet(item: $transit) { target in
            NavigationStack {
                TripTransitView(viewModel: viewModel, afterLegIndex: target.afterLegIndex,
                                existing: target.existing, suggested: target.suggested)
            }
        }
        .sheet(isPresented: $adding) {
            NavigationStack {
                TripAddLegView(viewModel: viewModel)
            }
        }
        .alert(removing?.isTransit == true ? "Weiterreise entfernen?" : "Stadt entfernen?", isPresented: Binding(
            get: { removing != nil }, set: { if !$0 { removing = nil } }),
               presenting: removing) { leg in
            Button("Entfernen", role: .destructive) {
                Task { await remove(leg) }
            }
            Button("Abbrechen", role: .cancel) { removing = nil }
        } message: { leg in
            if leg.isTransit {
                Text("Die Städte davor und danach behalten ihre Zeiten.")
            } else {
                Text("„\(leg.displayTitle)“ wird mit allen Tagen und allen Kandidaten gelöscht — "
                     + "auch mit dem, was jemand von Hand hinzugefügt hat.")
            }
        }
        .task {
            await viewModel.load()
            await loadSuggestion()
            userHome = await TripUserHome.load()
        }
        // A journey added or a city changed may answer the suggestion.
        .onChange(of: viewModel.plan?.legs.count) { _, _ in
            Task { await loadSuggestion() }
        }
    }

    private func setHome(_ place: TripPlace) async {
        savingHome = true
        defer { savingHome = false }
        struct Body: Encodable {
            let lat: Double
            let lon: Double
            let label: String
        }
        do {
            let response: TripPlanResponse = try await APIClient.shared.patch(
                "/trip-planner/plans/\(viewModel.planId)/home",
                body: Body(lat: place.latitude, lon: place.longitude, label: place.name))
            viewModel.replace(with: response)
            await loadSuggestion()
        } catch {
            errorMessage = TripErrorText.describe(error)
        }
    }

    private func clearHome() async {
        savingHome = true
        defer { savingHome = false }
        struct Body: Encodable { let clear: Bool }
        do {
            let response: TripPlanResponse = try await APIClient.shared.patch(
                "/trip-planner/plans/\(viewModel.planId)/home", body: Body(clear: true))
            viewModel.replace(with: response)
            await loadSuggestion()
        } catch {
            errorMessage = TripErrorText.describe(error)
        }
    }

    private func loadSuggestion() async {
        let response: TripTransitSuggestionResponse? = try? await APIClient.shared.get(
            "/trip-planner/plans/\(viewModel.planId)/transit-suggestion")
        guard let found = response?.suggestion,
              !UserDefaults.standard.bool(forKey: TripTransitSuggestion.dismissKey(
                planId: viewModel.planId, afterLegIndex: found.afterLegIndex))
        else {
            suggestion = nil
            return
        }
        suggestion = found
    }

    private func dismissSuggestion(_ found: TripTransitSuggestion) {
        UserDefaults.standard.set(true, forKey: TripTransitSuggestion.dismissKey(
            planId: viewModel.planId, afterLegIndex: found.afterLegIndex))
        suggestion = nil
    }

    /// The way into the journey screen — or, when a neighbour still has
    /// no date, the reason instead of a screen that refuses on save.
    /// The server's rule (§22.7): an undated trip takes its dates from
    /// the journey, but once some places are dated, the ones the journey
    /// touches have to be.
    @ViewBuilder
    private func journeyButton(_ title: String, systemImage: String, afterLegIndex: Int) -> some View {
        let blocker = TripTransitSlots.blocker(afterLegIndex: afterLegIndex, in: viewModel.plan?.legs ?? [])
        Button {
            transit = TransitTarget(afterLegIndex: afterLegIndex, existing: nil)
        } label: {
            VStack(alignment: .leading, spacing: 4) {
                Label(title, systemImage: systemImage)
                    .font(.subheadline)
                if let blocker {
                    Text(blocker)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .disabled(blocker != nil)
    }

    @ViewBuilder
    private func row(_ leg: TripLeg) -> some View {
        if leg.isTransit {
            transitRow(leg)
        } else {
            placeRow(leg)
        }
    }

    /// A journey: where from, where to, when, and how.
    private func transitRow(_ leg: TripLeg) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Label(leg.displayTitle, systemImage: leg.transportMode.systemImage)
                .font(.subheadline.weight(.semibold))
            HStack(spacing: 6) {
                if let window = leg.transitWindowText { Text(window) }
                Text("·")
                Text(leg.transportMode.label)
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            if let origin = leg.origin?.label {
                Text("von \(origin) nach \(leg.anchorTitle)")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.leading, 12)
    }

    private func placeRow(_ leg: TripLeg) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(leg.displayTitle).font(.headline)
            HStack(spacing: 6) {
                Text(leg.days.count == 1 ? "1 Tag" : "\(leg.days.count) Tage")
                Text("·")
                Label(leg.transportMode.label, systemImage: leg.transportMode.systemImage)
                if let date = leg.startDate,
                   let shown = leg.date(ofDayIndex: 0) {
                    Text("·")
                    Text(shown).accessibilityLabel(date)
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            if leg.isAwaitingRegion {
                // Which city the trip is waiting for, in the one list
                // that shows them all.
                Label("Karten werden noch geladen", systemImage: "map.circle")
                    .font(.caption2)
                    .foregroundStyle(Color.accentColor)
            }
            if leg.quartersAboard == true {
                // The pier, not a hotel (§21.3): leaving means "Alle an Bord".
                Label(leg.tenderPort == true ? "Unterkunft an Bord · Tenderhafen" : "Unterkunft an Bord",
                      systemImage: "ferry")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            if leg.anchorRadiusM != nil {
                // An anchor zone is not an address (§4.2).
                Text("Unterkunft noch offen")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func remove(_ leg: TripLeg) async {
        removing = nil
        isWorking = true
        defer { isWorking = false }
        do {
            let response: TripPlanResponse = try await APIClient.shared.delete(
                "/trip-planner/plans/\(viewModel.planId)/legs/\(leg.position)")
            viewModel.replace(with: response)
            errorMessage = nil
        } catch {
            errorMessage = TripErrorText.describe(error)
        }
    }
}

/// Adding a city to a trip that already exists.
///
/// The same fields as the draft screen, because it is the same
/// decision — and the same transfer, because a city added in the middle
/// shortens the day before it just as much as one named at the start.
struct TripAddLegView: View {
    @State var viewModel: TripPlannerViewModel
    @Environment(\.dismiss) private var dismiss

    @State private var leg = TripDraftLeg()
    @State private var isSaving = false
    @State private var errorMessage: String?

    var body: some View {
        TripDraftLegView(
            leg: $leg,
            position: viewModel.plan?.legs.count ?? 1,
            previousName: viewModel.plan?.legs.last?.title,
        )
        .plannerErrorBanner(errorMessage, dismiss: { errorMessage = nil })
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Abbrechen") { dismiss() }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button {
                    Task { await save() }
                } label: {
                    if isSaving { ProgressView() } else { Text("Hinzufügen") }
                }
                .disabled(leg.place == nil || isSaving)
            }
        }
    }

    private func save() async {
        guard let place = leg.place else { return }
        isSaving = true
        defer { isSaving = false }
        struct Body: Encodable {
            let title: String?
            let anchor: TripCreatePlanRequest.Coordinate
            let anchorLabel: String
            let anchorRadiusM: Int?
            let mode: String
            let days: Int
            let radiusM: Int
            let transfer: TripDraftTransfer?
        }
        do {
            let response: TripPlanResponse = try await APIClient.shared.post(
                "/trip-planner/plans/\(viewModel.planId)/legs",
                body: Body(
                    title: leg.effectiveTitle,
                    anchor: .init(lat: place.latitude, lon: place.longitude),
                    anchorLabel: place.name,
                    anchorRadiusM: leg.anchorIsApproximate ? leg.anchorRadiusM : nil,
                    mode: leg.mode.rawValue,
                    days: leg.days,
                    radiusM: leg.radiusM,
                    transfer: leg.transfer,
                ))
            viewModel.replace(with: response)
            dismiss()
        } catch {
            errorMessage = TripErrorText.describe(error)
        }
    }
}

/// Changing one city of an existing trip.
///
/// The split that matters is which changes cost the days: the name and
/// the date do not, the anchor, the length, the mode and the radius do.
/// The screen says which is which before you save, because the second
/// kind throws away the arrangement of a city you may have spent an
/// evening on — and is refused outright once a stop has been ticked off.
struct TripLegEditView: View {
    @State var viewModel: TripPlannerViewModel
    let legIndex: Int

    @Environment(\.dismiss) private var dismiss

    @State private var finder = TripPlaceFinderModel()
    @State private var title = ""
    @State private var movedTo: TripPlace?
    @State private var days = 1
    @State private var mode: TripTransportMode = .foot
    @State private var isDated = false
    @State private var startDate = Date()
    @State private var arriveAt: Date?
    @State private var quartersAboard = false
    @State private var tenderPort = false
    @State private var isSaving = false
    @State private var loaded = false
    @State private var errorMessage: String?

    private var leg: TripLeg? {
        viewModel.plan?.legs.first { $0.position == legIndex }
    }

    private static var defaultArrival: Date {
        Calendar.current.date(bySettingHour: 14, minute: 0, second: 0, of: Date()) ?? Date()
    }

    private static func time(fromMinutes minutes: Int) -> Date? {
        Calendar.current.date(
            bySettingHour: (minutes / 60) % 24, minute: minutes % 60, second: 0, of: Date())
    }

    var body: some View {
        Form {
            Section("Name") {
                TextField("Name der Stadt", text: $title)
            }

            Section {
                Stepper(value: $days, in: TripNewPlanDraft.minDays...TripNewPlanDraft.maxDays) {
                    Text(days == 1 ? "1 Tag" : "\(days) Tage")
                }
                TripTransportModePicker(mode: $mode)
                Toggle("Termin steht fest", isOn: $isDated)
                if isDated {
                    DatePicker("Erster Tag", selection: $startDate, displayedComponents: .date)
                }
            } header: {
                Text("Wie lange, wie unterwegs")
            } footer: {
                Text("Nur diese Stadt. Länge und Verkehrsmittel planen ihre Tage neu, Name und "
                     + "Datum nicht.")
            }

            Section {
                if let current = movedTo ?? leg.map({
                    TripPlace(name: $0.displayTitle, subtitle: nil,
                              latitude: $0.anchor.lat, longitude: $0.anchor.lon)
                }) {
                    TripPickedPlaceRow(place: current)
                }
                TripPlaceFinderRows(model: finder, picked: nil) { place in
                    movedTo = place
                    finder.clearResults()
                }
            } header: {
                Text("Unterkunft")
            } footer: {
                Text("Hotel, Campingplatz oder Adresse: hier fängt jeder Tag an und hier endet "
                     + "er, und von hier aus werden die Wege gerechnet. Verschieben plant die "
                     + "Tage neu.")
            }

            Section {
                Toggle("Ankunft ist bekannt", isOn: Binding(
                    get: { arriveAt != nil },
                    set: { on in
                        arriveAt = on ? (arriveAt ?? Self.defaultArrival) : nil
                    },
                ))
                if let arrival = arriveAt {
                    DatePicker("Ankunft", selection: Binding(
                        get: { arrival }, set: { arriveAt = $0 }),
                               displayedComponents: .hourAndMinute)
                }
            } header: {
                Text("Ankunft in dieser Stadt")
            } footer: {
                Text("Der erste Tag fängt dann erst dann an. Unabhängig davon, ab wann das "
                     + "Zimmer frei ist — ankommen und einchecken sind zwei Zeiten, und "
                     + "geplant wird ab der ersten.")
            }

            Section {
                Toggle("Unterkunft fährt mit", isOn: $quartersAboard)
                if quartersAboard {
                    Toggle("Tenderhafen", isOn: $tenderPort)
                }
            } header: {
                Text("Auf dem Schiff")
            } footer: {
                Text("Für einen Hafentag auf einer Kreuzfahrt: Die Unterkunft ist der Liegeplatz. "
                     + "Die Abfahrt der Weiterreise heißt dann „Alle an Bord“ und hält eine Stunde "
                     + "Puffer statt zwanzig Minuten; in einem Tenderhafen kommt die Bootsfahrt "
                     + "zurück mit einer halben Stunde dazu.")
            }

        }
        .navigationTitle(leg?.displayTitle ?? "Stadt")
        // Typed changes must not vanish on a swipe; "Abbrechen" is a tap away.
        .interactiveDismissDisabled()
        .plannerErrorBanner(errorMessage, dismiss: { errorMessage = nil })
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Abbrechen") { dismiss() }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button {
                    Task { await save() }
                } label: {
                    if isSaving { ProgressView() } else { Text("Sichern") }
                }
                .disabled(isSaving)
            }
        }
        .task {
            guard !loaded, let leg else { return }
            title = leg.title ?? ""
            days = leg.days.count
            mode = leg.transportMode
            isDated = leg.startDate != nil
            startDate = leg.startDate.flatMap { TripCalendar.date(fromIsoDay: $0) } ?? Date()
            arriveAt = leg.arriveMinutes.flatMap(Self.time(fromMinutes:))
            quartersAboard = leg.quartersAboard ?? false
            tenderPort = leg.tenderPort ?? false
            loaded = true
        }
    }

    private func save() async {
        guard let leg else { return }
        isSaving = true
        defer { isSaving = false }
        struct Body: Encodable {
            let title: String
            let anchor: TripCreatePlanRequest.Coordinate?
            let anchorLabel: String?
            let mode: String?
            let days: Int?
            let startDate: String??
            let arriveAt: String??
            let quartersAboard: Bool?
            let tenderPort: Bool?

            enum CodingKeys: String, CodingKey {
                case title, anchor, anchorLabel, mode, days, startDate, arriveAt
                case quartersAboard, tenderPort
            }

            func encode(to encoder: Encoder) throws {
                var c = encoder.container(keyedBy: CodingKeys.self)
                try c.encode(title, forKey: .title)
                try c.encodeIfPresent(anchor, forKey: .anchor)
                try c.encodeIfPresent(anchorLabel, forKey: .anchorLabel)
                try c.encodeIfPresent(mode, forKey: .mode)
                try c.encodeIfPresent(days, forKey: .days)
                // Double optionals: absent leaves the value alone, an
                // explicit null takes it off.
                if let startDate { try c.encode(startDate, forKey: .startDate) }
                if let arriveAt { try c.encode(arriveAt, forKey: .arriveAt) }
                try c.encodeIfPresent(quartersAboard, forKey: .quartersAboard)
                try c.encodeIfPresent(tenderPort, forKey: .tenderPort)
            }
        }
        let wantedDate: String? = isDated ? TripCalendar.isoDay(startDate) : nil
        let wantedArrival: String? = arriveAt.map(TripDraftTransfer.time(_:))
        let storedArrival: String? = leg.arriveMinutes.map(TripClock.format(_:))
        do {
            let response: TripPlanResponse = try await APIClient.shared.patch(
                "/trip-planner/plans/\(viewModel.planId)/legs/\(legIndex)",
                body: Body(
                    title: title.trimmingCharacters(in: .whitespacesAndNewlines),
                    anchor: movedTo.map { .init(lat: $0.latitude, lon: $0.longitude) },
                    // The anchor's own name travels with the anchor.
                    anchorLabel: movedTo?.name,
                    // Only what actually changed: an unchanged mode
                    // would turn every save into a re-plan, and a
                    // re-plan is refused once a day has begun.
                    mode: mode == leg.transportMode ? nil : mode.rawValue,
                    days: days == leg.days.count ? nil : days,
                    startDate: wantedDate == leg.startDate ? nil : .some(wantedDate),
                    arriveAt: wantedArrival == storedArrival ? nil : .some(wantedArrival),
                    // Only what changed: the property re-plans the last
                    // day when a journey leaves it, and a re-plan is
                    // refused once that day has begun.
                    quartersAboard: quartersAboard == (leg.quartersAboard ?? false) ? nil : quartersAboard,
                    tenderPort: (quartersAboard && tenderPort) == (leg.tenderPort ?? false) ? nil : (quartersAboard && tenderPort),
                ))
            viewModel.replace(with: response)
            dismiss()
        } catch {
            errorMessage = TripErrorText.describe(error)
        }
    }
}

/// Where a journey can go (§22.7): after a place, when the next leg is
/// a place too and nothing lies between them. Dates are not asked for:
/// a journey brings its own, and an undated trip takes them from it.
enum TripTransitSlots {
    /// The way there can be added when home is known and the trip does
    /// not already begin with a journey.
    static func wantsArrival(_ legs: [TripLeg], hasHome: Bool) -> Bool {
        guard hasHome, let first = legs.min(by: { $0.position < $1.position }) else { return false }
        return !first.isTransit
    }

    /// The way home: the last place's position, when home is known and
    /// the trip does not already end with a journey.
    static func wantsReturn(_ legs: [TripLeg], hasHome: Bool) -> Int? {
        guard hasHome, let last = legs.max(by: { $0.position < $1.position }),
              !last.isTransit else { return nil }
        return last.position
    }

    /// Why a journey cannot be made here yet, in one sentence — or nil.
    ///
    /// Mirrors `transits.ts`: with no date anywhere the journey dates
    /// the trip, so nothing blocks. Once any place is dated, the place
    /// being left and the place being reached both need a date, or the
    /// server refuses on save — better said before the screen opens
    /// than after the moments were typed.
    static func blocker(afterLegIndex: Int, in legs: [TripLeg]) -> String? {
        guard legs.contains(where: { $0.startDate != nil }) else { return nil }
        let from = legs.first { $0.position == afterLegIndex }
        let to = legs.first { $0.position > afterLegIndex && !$0.isTransit }
        let undated = [from, to].compactMap { $0 }.filter { $0.startDate == nil }
        guard let first = undated.first else { return nil }
        return "„\(first.displayTitle)“ hat noch kein Datum — erst der Stadt ein Datum geben, "
            + "dann die \(afterLegIndex < 0 ? "Anreise" : to == nil ? "Heimreise" : "Weiterreise") anlegen."
    }

    static func slotAfter(_ leg: TripLeg, in legs: [TripLeg]) -> Int? {
        guard !leg.isTransit,
              let next = legs.first(where: { $0.position == leg.position + 1 }),
              !next.isTransit
        else { return nil }
        return leg.position
    }
}

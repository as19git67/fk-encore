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
    @State private var isWorking = false
    @State private var errorMessage: String?

    var body: some View {
        List {
            Section {
                ForEach(viewModel.plan?.legs.sorted(by: { $0.position < $1.position }) ?? []) { leg in
                    NavigationLink {
                        TripLegEditView(viewModel: viewModel, legIndex: leg.position)
                    } label: {
                        row(leg)
                    }
                    .swipeActions(edge: .trailing) {
                        Button(role: .destructive) { removing = leg } label: {
                            Label("Entfernen", systemImage: "trash")
                        }
                    }
                }
            } footer: {
                Text("Jede Stadt hat ihren eigenen Ausgangspunkt, ihr eigenes Verkehrsmittel "
                     + "und ihren eigenen Vorrat. Umverteilt wird immer nur innerhalb einer "
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

            if let errorMessage {
                Section {
                    Text(errorMessage).font(.footnote).foregroundStyle(.red)
                }
            }
        }
        .navigationTitle("Etappen")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $adding) {
            NavigationStack {
                TripAddLegView(viewModel: viewModel)
            }
        }
        .alert("Stadt entfernen?", isPresented: Binding(
            get: { removing != nil }, set: { if !$0 { removing = nil } }),
               presenting: removing) { leg in
            Button("Entfernen", role: .destructive) {
                Task { await remove(leg) }
            }
            Button("Abbrechen", role: .cancel) { removing = nil }
        } message: { leg in
            Text("„\(leg.displayTitle)“ wird mit allen Tagen und dem ganzen Vorrat gelöscht — "
                 + "auch mit dem, was jemand von Hand hinzugefügt hat.")
        }
        .task { await viewModel.load() }
    }

    private func row(_ leg: TripLeg) -> some View {
        VStack(alignment: .leading, spacing: 2) {
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
            errorMessage = error.localizedDescription
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
        .safeAreaInset(edge: .bottom) {
            if let errorMessage {
                Text(errorMessage)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .padding()
                    .frame(maxWidth: .infinity)
                    .background(.bar)
            }
        }
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
            errorMessage = error.localizedDescription
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
                TextField("Name der Etappe", text: $title)
            }

            Section {
                Stepper(value: $days, in: TripNewPlanDraft.minDays...TripNewPlanDraft.maxDays) {
                    Text(days == 1 ? "1 Tag" : "\(days) Tage")
                }
                Picker("Unterwegs", selection: $mode) {
                    ForEach(TripTransportMode.allCases, id: \.self) { m in
                        Label(m.label, systemImage: m.systemImage).tag(m)
                    }
                }
                Toggle("Termin steht fest", isOn: $isDated)
                if isDated {
                    DatePicker("Erster Tag", selection: $startDate, displayedComponents: .date)
                }
            } header: {
                Text("Wie lange, wie unterwegs")
            } footer: {
                Text("Länge und Verkehrsmittel planen die Tage dieser Stadt neu. Name und "
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

            if let errorMessage {
                Section {
                    Text(errorMessage).font(.footnote).foregroundStyle(.red)
                }
            }
        }
        .navigationTitle(leg?.displayTitle ?? "Etappe")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button {
                    Task { await save() }
                } label: {
                    if isSaving { ProgressView() } else { Text("Speichern") }
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

            enum CodingKeys: String, CodingKey {
                case title, anchor, anchorLabel, mode, days, startDate, arriveAt
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
                ))
            viewModel.replace(with: response)
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

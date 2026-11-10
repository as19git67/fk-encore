import SwiftUI

/// The sheets of the itinerary (documentation/plans/reise-planen-und-unterwegs.md,
/// stage 2): a new stay, a stay's details, a journey, a port put into a
/// ship journey, and home.
///
/// Every sheet edits a copy of the chain and hands the whole copy back
/// on "Hinzufügen" or "Fertig". The itinerary saves it at once
/// (`PUT …/itinerary`), so a sheet that closes without an error has
/// written what it shows; "Abbrechen" leaves the trip as it was.

/// What a sheet hands back: nil when the chain was saved, otherwise the
/// sentence that says why not, shown in the sheet.
typealias TripItineraryCommit = (TripItineraryDraft) async -> String?

// MARK: - A stay

struct TripStaySheet: View {
    enum Purpose { case new, edit }

    @State var draft: TripItineraryDraft
    let stayId: TripItineraryItem.ID
    let purpose: Purpose
    let onCommit: TripItineraryCommit
    /// "Aufenthalt planen": back to the stay's days.
    var onPlan: (() -> Void)? = nil
    /// "Aufenthalt entfernen", with the itinerary's undo.
    var onRemove: (() -> Void)? = nil
    /// The journey on one side, whose times the stay only shows.
    var onOpenJourney: ((TripItineraryItem.ID) -> Void)? = nil

    @Environment(\.dismiss) private var dismiss
    @State private var finder = TripPlaceFinderModel()
    @State private var searching = false
    @State private var saving = false
    @State private var error: String?

    private var stay: TripItineraryItem { draft[stayId] ?? TripItineraryItem(kind: .stay) }

    private func update(_ change: (inout TripItineraryItem) -> Void) {
        guard var item = draft[stayId] else { return }
        change(&item)
        draft[stayId] = item
    }

    var body: some View {
        let dated = draft.dated().first { $0.item.id == stayId }
        Form {
            if purpose == .edit {
                Section {
                    TextField("Name", text: Binding(
                        get: { stay.title ?? "" },
                        set: { value in update { $0.title = value } },
                    ))
                    .textInputAutocapitalization(.words)
                } header: {
                    Text("Name")
                }
            }

            Section {
                if let place = stay.place, !searching {
                    HStack {
                        Label(place.name, systemImage: "mappin.circle.fill")
                            .lineLimit(2)
                        Spacer()
                        Button("Ändern") {
                            finder.query = place.name
                            finder.clearResults()
                            searching = true
                        }
                        .buttonStyle(.borderless)
                    }
                } else {
                    TripPlaceFinderRows(model: finder, picked: nil) { place in
                        update { $0.place = place }
                        finder.clearResults()
                        searching = false
                    }
                }
            } header: {
                Text("Wo?")
            } footer: {
                Text("Ein Ort oder gleich die Unterkunft. Hier fängt jeder Tag an und hört auf.")
            }

            Section {
                if draft.ownsStart(stayId) {
                    TripOptionalDateRow(title: "Von", day: $draft.startDate)
                }
                Stepper(value: Binding(
                    get: { stay.days ?? 1 },
                    set: { value in update { $0.days = value } },
                ), in: TripItineraryDraft.minStayDays...TripItineraryDraft.maxStayDays) {
                    LabeledContent("Wie lange?", value: TripItineraryText.stayLength(days: stay.days ?? 1))
                }
                LabeledContent(purpose == .new ? "Bis" : "Von, Bis") {
                    Text(span(dated))
                        .foregroundStyle(.secondary)
                }
            } footer: {
                Text(draft.ownsStart(stayId)
                     ? "Das „Von“ des ersten Aufenthalts ist der Beginn der Reise; alle anderen Daten "
                        + "werden daraus gerechnet. Ohne Datum heißen die Tage „Tag 1“ bis „Tag n“."
                     : "Von und Bis folgen aus dem Beginn der Reise und den Längen davor.")
            }

            if purpose == .edit {
                timesSection
            }

            Section {
                Picker("Vor Ort", selection: Binding(
                    get: { stay.transportMode == .ship || stay.transportMode == .plane ? .foot : stay.transportMode },
                    set: { mode in
                        update { item in
                            if let current = item.radiusM {
                                item.radiusM = TripReach.radius(movingFrom: item.transportMode, to: mode, current: current)
                            }
                            item.transportMode = mode
                        }
                    },
                )) {
                    ForEach(TripTransportMode.forPlaces, id: \.self) { mode in
                        Label(mode.label, systemImage: mode.systemImage).tag(mode)
                    }
                }
            }

            lodgingSection

            if let error {
                Section {
                    Label(error, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.red)
                }
            }

            if purpose == .edit {
                if let onPlan {
                    Section {
                        Button {
                            dismiss()
                            onPlan()
                        } label: {
                            Label("Aufenthalt planen", systemImage: "calendar")
                        }
                    }
                }
                if let onRemove, draft.stayCount > 1 {
                    Section {
                        Button("Aufenthalt entfernen", role: .destructive) {
                            dismiss()
                            onRemove()
                        }
                    }
                }
            }
        }
        .navigationTitle(purpose == .new ? "Neuer Aufenthalt" : "Aufenthalt")
        .navigationBarTitleDisplayMode(.inline)
        .interactiveDismissDisabled(saving)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Abbrechen") { dismiss() }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button {
                    Task { await save() }
                } label: {
                    if saving { ProgressView() } else { Text(purpose == .new ? "Hinzufügen" : "Fertig") }
                }
                .disabled(saving || stay.anchor == nil)
            }
        }
        .onAppear {
            if stay.anchor == nil { searching = true }
        }
    }

    /// Arrival and departure belong to the journeys; the stay shows
    /// them and "›" opens the journey that owns them.
    @ViewBuilder
    private var timesSection: some View {
        let before = draft.journey(before: stayId)
        let after = draft.journey(after: stayId)
        Section {
            if let before {
                journeyRow("Ankunft", time: before.arriveAt, journey: before)
            } else {
                TripOptionalClockRow(title: "Ankunft", clock: Binding(
                    get: { stay.arriveAt },
                    set: { value in update { $0.arriveAt = value } },
                ), defaultMinutes: 15 * 60)
            }
            if let after {
                journeyRow("Abfahrt", time: after.departAt, journey: after)
            }
        } footer: {
            Text("Die Zeiten stehen an den Weiterreisen; „›“ öffnet sie.")
        }
    }

    private func journeyRow(_ title: String, time: String?, journey: TripItineraryItem) -> some View {
        Button {
            dismiss()
            onOpenJourney?(journey.id)
        } label: {
            HStack {
                Text(title).foregroundStyle(.primary)
                Spacer()
                Text("\(time ?? "offen") · \(draft.name(of: journey))")
                    .foregroundStyle(.secondary)
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .disabled(onOpenJourney == nil)
    }

    @ViewBuilder
    private var lodgingSection: some View {
        Section {
            if draft.isBetweenShips(stayId) {
                LabeledContent("Übernachtung", value: "an Bord")
            } else {
                Toggle("Noch nichts gebucht", isOn: Binding(
                    get: { stay.anchorRadiusM != nil },
                    set: { on in update { $0.anchorRadiusM = on ? ($0.anchorRadiusM ?? 1_000) : nil } },
                ))
                Toggle("Übernachtung an Bord", isOn: Binding(
                    get: { stay.quartersAboard ?? false },
                    set: { on in
                        update {
                            $0.quartersAboard = on
                            if !on { $0.tenderPort = false }
                        }
                    },
                ))
            }
            if draft.isBetweenShips(stayId) || stay.quartersAboard == true {
                Toggle("Tenderhafen", isOn: Binding(
                    get: { stay.tenderPort ?? false },
                    set: { on in update { $0.tenderPort = on } },
                ))
            }
        } header: {
            Text("Übernachtung")
        } footer: {
            if draft.isBetweenShips(stayId) {
                Text("Davor und danach fährt ein Schiff, also wird an Bord übernachtet. „Alle an Bord“ "
                     + "ist eine Stunde vor der Abfahrt, in einem Tenderhafen anderthalb.")
            } else {
                Text("Ohne Unterkunft ist die Mitte des Orts der Ausgangspunkt, und die App sucht "
                     + "im Umkreis von 15 km.")
            }
        }
    }

    private func span(_ dated: TripItineraryDated?) -> String {
        guard let dated else { return "" }
        if let start = dated.startDate, let end = dated.endDate {
            return purpose == .new
                ? TripItineraryText.shortDate(end)
                : "\(TripItineraryText.shortDate(start)) bis \(TripItineraryText.shortDate(end))"
        }
        let offsets = TripItineraryText.dayOffsets(of: draft)
        guard let i = draft.index(of: stayId), i < offsets.count else { return "" }
        return TripItineraryText.span(dated, dayOffsets: offsets[i])
    }

    private func save() async {
        if let problem = draft.problems().first {
            error = problem
            return
        }
        saving = true
        defer { saving = false }
        if let refusal = await onCommit(draft) {
            error = refusal
        } else {
            dismiss()
        }
    }
}

// MARK: - A journey

struct TripJourneySheet: View {
    @State var draft: TripItineraryDraft
    let journeyId: TripItineraryItem.ID
    let onCommit: TripItineraryCommit
    /// "Hafen einfügen" on a ship journey between two stays.
    var onInsertPort: ((TripItineraryItem.ID) -> Void)? = nil

    @Environment(\.dismiss) private var dismiss
    @State private var saving = false
    @State private var error: String?

    /// The modes a journey offers, in the order people name them.
    private static let modes: [TripTransportMode] = [.plane, .transit, .car, .ship, .bike, .foot]

    private var journey: TripItineraryItem { draft[journeyId] ?? TripItineraryItem(kind: .journey) }

    private func update(_ change: (inout TripItineraryItem) -> Void) {
        guard var item = draft[journeyId] else { return }
        change(&item)
        draft[journeyId] = item
    }

    private var isOutbound: Bool { draft.outbound?.id == journeyId }
    private var timesOpen: Bool { journey.departAt == nil && journey.arriveAt == nil }

    var body: some View {
        let ends = draft.ends(of: journey)
        Form {
            Section {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(Self.modes, id: \.self) { mode in
                            modeChip(mode)
                        }
                    }
                    .padding(.vertical, 4)
                }
            } header: {
                Text("\(ends.from) → \(ends.to)")
                    .textCase(nil)
            }

            if isOutbound {
                Section {
                    LabeledContent("Ab", value: draft.homeLabel)
                    TripOptionalDateRow(title: "Von", day: $draft.startDate)
                } footer: {
                    Text("Zuhause ist einmal festgelegt und gilt für jede Reise. Das „Von“ der "
                         + "Anreise ist der Beginn der Reise.")
                }
            }

            Section {
                Toggle("Zeiten noch offen", isOn: Binding(
                    get: { timesOpen },
                    set: { open in
                        update { item in
                            if open {
                                item.departAt = nil
                                item.arriveAt = nil
                            } else {
                                item.departAt = item.departAt ?? TripClock.format(isOutbound ? 8 * 60 : 10 * 60)
                                item.arriveAt = item.arriveAt ?? TripClock.format(15 * 60)
                            }
                        }
                    },
                ))
                if !timesOpen {
                    TripOptionalClockRow(title: "Abfahrt", clock: Binding(
                        get: { journey.departAt },
                        set: { value in update { $0.departAt = value } },
                    ), defaultMinutes: 10 * 60, place: ends.from)
                    TripOptionalClockRow(title: "Ankunft", clock: Binding(
                        get: { journey.arriveAt },
                        set: { value in update { $0.arriveAt = value } },
                    ), defaultMinutes: 15 * 60, place: ends.to)
                }
            } footer: {
                if timesOpen {
                    Text("Solange die Zeiten offen sind, rechnet der Tag mit Vorgaben: Abfahrt 10:00, "
                         + "Ankunft 15:00, Anreise von Zuhause ab 08:00.")
                } else if let shift = TripItineraryText.zoneShift(journey.zoneShiftMinutes) {
                    Text("Ortszeit. Die Uhr springt auf dieser Fahrt um \(shift).")
                } else {
                    Text("Ortszeit, am Ort der Abfahrt und am Ort der Ankunft.")
                }
            }

            Section {
                Stepper(value: Binding(
                    get: { journey.nights ?? 0 },
                    set: { value in update { $0.nights = value } },
                ), in: 0...TripItineraryDraft.maxNights(for: journey.transportMode)) {
                    LabeledContent("Nächte unterwegs", value: "\(journey.nights ?? 0)")
                }
                LabeledContent("Ergibt") {
                    Text(arrivalText)
                        .foregroundStyle(.secondary)
                }
            } footer: {
                Text("Nachtzug, Fähre, Flug über Nacht oder Seetage.")
            }

            if journey.transportMode == .ship, draft.stay(before: journeyId) != nil,
               draft.stay(after: journeyId) != nil, let onInsertPort {
                Section {
                    Button {
                        dismiss()
                        onInsertPort(journeyId)
                    } label: {
                        Label("Hafen einfügen", systemImage: "plus.circle")
                    }
                } footer: {
                    Text("Ein Hafen teilt die Fahrt; das Ende der Reise bleibt, wo es ist.")
                }
            }

            if let error {
                Section {
                    Label(error, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.red)
                }
            }
        }
        .navigationTitle(draft.name(of: journey))
        .navigationBarTitleDisplayMode(.inline)
        .interactiveDismissDisabled(saving)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Abbrechen") { dismiss() }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button {
                    Task { await save() }
                } label: {
                    if saving { ProgressView() } else { Text("Fertig") }
                }
                .disabled(saving)
            }
        }
    }

    private func modeChip(_ mode: TripTransportMode) -> some View {
        let selected = journey.transportMode == mode
        return Button {
            update { item in
                item.transportMode = mode
                item.nights = min(item.nights ?? 0, TripItineraryDraft.maxNights(for: mode))
            }
        } label: {
            Label(Self.chipLabel(mode), systemImage: mode.systemImage)
                .font(.subheadline)
                .padding(.horizontal, 12)
                .frame(minHeight: 36)
                .background(selected ? Color.accentColor.opacity(0.15) : Color.clear, in: .capsule)
                .overlay(Capsule().strokeBorder(selected ? Color.accentColor : Color.secondary.opacity(0.4)))
                .contentShape(.capsule)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    static func chipLabel(_ mode: TripTransportMode) -> String {
        switch mode {
        case .plane: return "Flug"
        case .transit: return "Bahn, Bus"
        case .car: return "Auto"
        case .ship: return "Schiff"
        case .bike: return "Rad"
        case .foot: return "zu Fuß"
        }
    }

    /// "an Mi., 25. Nov. 21:05", "am selben Tag", "2 Tage später".
    private var arrivalText: String {
        let dated = draft.dated().first { $0.item.id == journeyId }
        let time = journey.arriveAt.map { " \($0)" } ?? ""
        if let end = dated?.endDate {
            return "an \(TripItineraryText.shortDate(end))\(time)"
        }
        return TripItineraryText.arrival(nights: journey.nights ?? 0) + time
    }

    private func save() async {
        if let problem = draft.problems().first {
            error = problem
            return
        }
        saving = true
        defer { saving = false }
        if let refusal = await onCommit(draft) {
            error = refusal
        } else {
            dismiss()
        }
    }
}

// MARK: - A port in a ship journey

/// "Neuer Hafen": where, ashore from, aboard until (plan, "Cruises").
/// The length follows from the two times; the night is aboard.
struct TripPortSheet: View {
    let draft: TripItineraryDraft
    let journeyId: TripItineraryItem.ID
    let onCommit: TripItineraryCommit

    @Environment(\.dismiss) private var dismiss
    @State private var finder = TripPlaceFinderModel()
    @State private var place: TripPlace?
    @State private var ashoreAfter = 0
    @State private var aboardAfter = 0
    @State private var ashoreFrom = "08:00"
    @State private var aboardUntil = "18:00"
    @State private var saving = false
    @State private var error: String?

    private var journey: TripItineraryItem? { draft[journeyId] }
    private var nights: Int { journey?.nights ?? 0 }
    private var journeyStart: String? { draft.dated().first { $0.item.id == journeyId }?.startDate }
    private var days: Int { max(1, aboardAfter - ashoreAfter + 1) }

    var body: some View {
        Form {
            Section {
                if let place {
                    HStack {
                        Label(place.name, systemImage: "mappin.circle.fill")
                        Spacer()
                        Button("Ändern") { self.place = nil }
                            .buttonStyle(.borderless)
                    }
                } else {
                    TripPlaceFinderRows(model: finder, picked: nil) { picked in
                        place = picked
                        finder.clearResults()
                    }
                }
            } header: {
                Text("Wo?")
            }

            Section {
                Picker("An Land ab", selection: $ashoreAfter) {
                    ForEach(0...nights, id: \.self) { offset in
                        Text(dayLabel(offset)).tag(offset)
                    }
                }
                TripClockRow(title: "Uhrzeit", clock: $ashoreFrom)
                Picker("An Bord bis", selection: $aboardAfter) {
                    ForEach(ashoreAfter...nights, id: \.self) { offset in
                        Text(dayLabel(offset)).tag(offset)
                    }
                }
                TripClockRow(title: "Uhrzeit", clock: $aboardUntil)
            } footer: {
                Text("Die Zeiten landen an den Schiffsfahrten davor und danach.")
            }

            Section {
                LabeledContent("Ergibt", value: TripItineraryText.stayLength(days: days))
                LabeledContent("Übernachtung", value: "an Bord")
            }

            if let error {
                Section {
                    Label(error, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.red)
                }
            }
        }
        .navigationTitle("Neuer Hafen")
        .navigationBarTitleDisplayMode(.inline)
        .interactiveDismissDisabled(saving)
        .onChange(of: ashoreAfter) { _, value in
            if aboardAfter < value { aboardAfter = value }
        }
        .onAppear {
            ashoreAfter = min(1, nights)
            aboardAfter = ashoreAfter
        }
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Abbrechen") { dismiss() }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button {
                    Task { await save() }
                } label: {
                    if saving { ProgressView() } else { Text("Hinzufügen") }
                }
                .disabled(saving || place == nil)
            }
        }
    }

    /// "Fr., 27. Nov." with a date, "Tag 2 der Fahrt" without.
    private func dayLabel(_ offset: Int) -> String {
        if let start = journeyStart, let day = TripCalendar.day(start, plus: offset) {
            return TripItineraryText.shortDate(day)
        }
        return "Tag \(offset + 1) der Fahrt"
    }

    private func save() async {
        guard let place else { return }
        var next = draft
        guard let portId = next.insertPort(into: journeyId, ashoreAfter: ashoreAfter, days: days,
                                           ashoreFrom: ashoreFrom, aboardUntil: aboardUntil),
              var port = next[portId]
        else {
            error = "Der Hafen passt so nicht in die Fahrt: an Land muss nach der Abfahrt sein, "
                + "an Bord vor der Ankunft am nächsten Hafen."
            return
        }
        port.place = place
        next[portId] = port
        saving = true
        defer { saving = false }
        if let refusal = await onCommit(next) {
            error = refusal
        } else {
            dismiss()
        }
    }
}

// MARK: - Home

struct TripHomeSheet: View {
    let current: TripHome?
    let userHome: TripHome?
    let onSet: (TripPlace) async -> Void
    let onClear: () async -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var finder = TripPlaceFinderModel()

    var body: some View {
        Form {
            if let current {
                Section {
                    Label(current.displayLabel, systemImage: "house")
                    Button("Zuhause entfernen", role: .destructive) {
                        Task {
                            await onClear()
                            dismiss()
                        }
                    }
                }
            }
            Section {
                if let userHome, current == nil {
                    Button {
                        Task {
                            await onSet(TripPlace(name: userHome.displayLabel, subtitle: nil,
                                                  latitude: userHome.lat, longitude: userHome.lon))
                            dismiss()
                        }
                    } label: {
                        Label("„\(userHome.displayLabel)“ übernehmen", systemImage: "house")
                    }
                }
                TripPlaceFinderRows(model: finder, picked: nil) { place in
                    finder.clearResults()
                    Task {
                        await onSet(place)
                        dismiss()
                    }
                }
            } header: {
                Text(current == nil ? "Zuhause festlegen" : "Anderes Zuhause")
            } footer: {
                Text("Von hier geht es los, und hierher zurück. Mit einem Zuhause stehen Anreise und "
                     + "Heimreise als Weiterreisen im Verlauf.")
            }
        }
        .navigationTitle("Zuhause")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Fertig") { dismiss() }
            }
        }
    }
}

// MARK: - Small rows

/// A day that may not be known yet: a toggle carries the knowledge and
/// the picker only the date, so "no date" never reads as today.
struct TripOptionalDateRow: View {
    let title: String
    @Binding var day: String?

    var body: some View {
        Toggle("\(title): Datum steht fest", isOn: Binding(
            get: { day != nil },
            set: { on in day = on ? (day ?? TripCalendar.isoDay(Date())) : nil },
        ))
        if let current = day {
            DatePicker(title, selection: Binding(
                get: { TripCalendar.date(fromIsoDay: current) ?? Date() },
                set: { day = TripCalendar.isoDay($0) },
            ), displayedComponents: .date)
        }
    }
}

/// A clock time as "HH:MM", edited with the system's time picker.
struct TripClockRow: View {
    let title: String
    @Binding var clock: String
    var defaultMinutes = 10 * 60
    /// Where the time is: the place a journey leaves from or comes to.
    var place: String? = nil

    var body: some View {
        DatePicker(selection: Binding(
            get: {
                let minutes = TripClock.minutes(fromClock: clock) ?? defaultMinutes
                return Calendar.current.date(bySettingHour: minutes / 60, minute: minutes % 60,
                                             second: 0, of: Date()) ?? Date()
            },
            set: { date in
                let parts = Calendar.current.dateComponents([.hour, .minute], from: date)
                clock = TripClock.format((parts.hour ?? 0) * 60 + (parts.minute ?? 0))
            },
        ), displayedComponents: .hourAndMinute) {
            TripClockRowLabel(title: title, place: place)
        }
    }
}

/// The title of a time, with its place underneath when it has one.
struct TripClockRowLabel: View {
    let title: String
    let place: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
            if let place {
                Text(place)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// A time that may still be open: "offen" with a button, or the picker
/// with a way back to "offen".
struct TripOptionalClockRow: View {
    let title: String
    @Binding var clock: String?
    let defaultMinutes: Int
    /// Where the time is: the place a journey leaves from or comes to.
    var place: String? = nil

    var body: some View {
        if let current = clock {
            HStack {
                TripClockRow(title: title, clock: Binding(
                    get: { current },
                    set: { clock = $0 },
                ), defaultMinutes: defaultMinutes, place: place)
                Button {
                    clock = nil
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.tertiary)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("\(title) offen lassen")
            }
        } else {
            HStack {
                TripClockRowLabel(title: title, place: place)
                Spacer()
                Button("offen · festlegen") { clock = TripClock.format(defaultMinutes) }
                    .buttonStyle(.borderless)
            }
        }
    }
}

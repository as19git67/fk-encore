import SwiftUI

/// Sending one day of the trip somewhere else (§4.5).
///
/// The case this exists for is the commonest holiday there is and could
/// not be said at all until now:
///
/// > Three days in an Airbnb in San Gimignano. One day out to Pisa, one
/// > to Florence. The rest of the time in San Gimignano.
///
/// One leg — the quarters never move, there is no transfer day, the
/// luggage stays put — and only the day goes elsewhere. Modelling it as
/// three legs would promise three hotels and three pools nothing slips
/// between, which is the opposite of what anybody means by it.
///
/// The two hours are optional and matter more than they look. Without a
/// routing engine the drive is a straight line with a detour factor on
/// it (§12) — good enough to charge a block, never as good as somebody
/// who has actually looked the drive up. Naming the departure and the
/// return replaces the guess with what they know.
struct TripDayAnchorSheet: View {
    let dayLabel: String
    /// What the day says today, so the sheet can offer to undo it.
    let current: TripDayAnchor?
    /// The excursion being changed, when the sheet opened from one.
    var excursion: TripExcursion? = nil
    /// "Ganzer Tag" is offered only on a day without other excursions.
    var allowsWholeDay = true
    /// A time window inside the day (Anton, 10./11.11.); nil on a host
    /// that only knows whole days. Nil when it was saved, otherwise what
    /// went wrong: the sheet says it, since the screen behind is covered.
    var onSaveWindow: ((TripPlannerViewModel.ExcursionDraft) async -> String?)? = nil
    var onRemoveExcursion: (() async -> Void)? = nil
    /// Another day of the stay to move the outing to, with its label;
    /// empty when there is none.
    var moveTargets: [MoveTarget] = []
    var onMove: ((Int) async -> Void)? = nil
    /// Nil when it was saved, otherwise what went wrong.
    let onSave: (Draft?) async -> String?

    /// A day the outing can move to.
    struct MoveTarget: Identifiable {
        let dayIndex: Int
        let label: String
        var id: Int { dayIndex }
    }

    /// How much of the day the outing takes.
    enum Span: String, CaseIterable, Identifiable {
        case wholeDay
        case window
        var id: String { rawValue }
        var label: String { self == .wholeDay ? "Ganzer Tag" : "Zeitfenster" }
    }

    /// What the sheet hands back — the place and, if anybody said, the
    /// two hours that frame the outing.
    struct Draft {
        let place: TripPlace
        /// Minutes past midnight, or nil when the traveller left the
        /// switch off: an hour nobody meant is worse than no hour.
        let departMinutes: Int?
        let returnMinutes: Int?
        /// How far to look around the place. Nil is the ordinary
        /// answer: the server's own default, not a number this sheet
        /// happens to know today.
        let radiusM: Int?
    }

    @State private var finder = TripPlaceFinderModel()
    @State private var place: TripPlace?
    /// Searching for a replacement while the current place stays put.
    /// "Ändern" used to clear it, so a mis-tap while correcting the
    /// return time meant searching the place again.
    @State private var changingPlace = false
    @State private var reach = TripOutingReach.place
    @State private var saysDeparture = false
    @State private var saysReturn = false
    @State private var departure = Self.defaultDeparture
    @State private var back = Self.defaultReturn
    @State private var saving = false
    @State private var span = Span.window
    /// What the server said when saving failed.
    @State private var failure: String?
    @Environment(\.dismiss) private var dismiss

    private var windowed: Bool { onSaveWindow != nil && span == .window }

    /// Out at 10:00, back at 13:00: half a day, as in the mock.
    static var defaultWindowDeparture: Date { at(hour: 10, minute: 0) }
    static var defaultWindowReturn: Date { at(hour: 13, minute: 0) }

    private var travelMinutes: Int? { excursion?.travelMinutes ?? current?.travelMinutes }

    /// 8:30 out, 17:30 back — the shape of a day trip. "Now" would be a
    /// time nobody means.
    static var defaultDeparture: Date { at(hour: 8, minute: 30) }
    static var defaultReturn: Date { at(hour: 17, minute: 30) }

    private static func at(hour: Int, minute: Int) -> Date {
        Calendar.current.date(bySettingHour: hour, minute: minute, second: 0, of: Date()) ?? Date()
    }

    private var departMinutes: Int? {
        saysDeparture || windowed ? TripDayTimeline.minutesOfDay(departure) : nil
    }

    private var returnMinutes: Int? {
        saysReturn || windowed ? TripDayTimeline.minutesOfDay(back) : nil
    }

    var body: some View {
        NavigationStack {
            Form {
                if let failure {
                    Section {
                        Label(failure, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(.red)
                            .font(.footnote)
                    }
                }
                Section {
                    if let place, !changingPlace {
                        HStack {
                            Label(place.name, systemImage: "mappin.circle.fill").lineLimit(2)
                            Spacer()
                            Button("Ändern") { changingPlace = true }
                                .buttonStyle(.borderless)
                                .font(.footnote)
                        }
                    } else {
                        TripPlaceFinderRows(model: finder, picked: nil) { picked in
                            place = picked
                            changingPlace = false
                        }
                        if place != nil {
                            Button("Doch behalten") { changingPlace = false }
                                .font(.footnote)
                        }
                    }
                } header: {
                    Text(dayLabel)
                } footer: {
                    // What it *does*, not that it is possible. The day
                    // is planned around this place and the drive is
                    // taken off its blocks — that is the whole point,
                    // and it is why the day gets shorter.
                    Text("Der Tag wird um diesen Ort herum geplant, statt um die Unterkunft. "
                         + "Hin- und Rückfahrt gehen von den Blöcken dieses Tages ab — eine "
                         + "Stunde hin und eine zurück heißt: sechs Stunden statt acht.")
                }

                if onSaveWindow != nil && excursion == nil && allowsWholeDay {
                    Section {
                        Picker("Wie lange", selection: $span.animation()) {
                            ForEach(Span.allCases) { option in
                                Text(option.label).tag(option)
                            }
                        }
                        .pickerStyle(.segmented)
                    } header: {
                        Text("Wie lange")
                    } footer: {
                        Text(span == .window
                             ? "Davor und danach plant der Tag am Ort der Unterkunft. Mehrere Ausflüge an einem Tag gehen, solange sie sich nicht überschneiden."
                             : "Der ganze Tag findet am Ziel statt.")
                    }
                }

                if windowed {
                    windowHours
                }

                reachSection

                if !windowed {
                    hours
                }

                if let onMove, !moveTargets.isEmpty, excursion != nil || current != nil {
                    Section {
                        Menu {
                            ForEach(moveTargets) { target in
                                Button(target.label) {
                                    saving = true
                                    Task {
                                        await onMove(target.dayIndex)
                                        saving = false
                                        dismiss()
                                    }
                                }
                            }
                        } label: {
                            Label("Auf anderen Tag", systemImage: "calendar")
                        }
                        .disabled(saving)
                    } footer: {
                        Text("Die Spots des Ausflugs gehen mit.")
                    }
                }

                if let excursion, let onRemoveExcursion {
                    Section {
                        Button(role: .destructive) {
                            saving = true
                            Task {
                                await onRemoveExcursion()
                                saving = false
                                dismiss()
                            }
                        } label: {
                            Label("Ausflug entfernen", systemImage: "trash")
                        }
                        .disabled(saving)
                    } footer: {
                        Text("Die Spots von \(excursion.displayName) gehen zurück zu den Ideen.")
                    }
                } else if let current {
                    Section {
                        Button(role: .destructive) {
                            saving = true
                            Task {
                                failure = await onSave(nil)
                                saving = false
                                if failure == nil { dismiss() }
                            }
                        } label: {
                            Label("Ausflug entfernen", systemImage: "house")
                        }
                        .disabled(saving)
                    } footer: {
                        Text("Der Tag findet dann wieder rund um die Unterkunft statt. "
                             + "Bisher: \(current.summary).")
                    }
                }
            }
            .navigationTitle("Ausflug")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Abbrechen") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        guard let place else { return }
                        saving = true
                        failure = nil
                        Task {
                            if windowed, let onSaveWindow, let depart = departMinutes, let home = returnMinutes {
                                failure = await onSaveWindow(TripPlannerViewModel.ExcursionDraft(
                                    place: place, departMinutes: depart, returnMinutes: home, radiusM: reach.radiusM))
                            } else {
                                failure = await onSave(Draft(
                                    place: place,
                                    departMinutes: departMinutes,
                                    returnMinutes: returnMinutes,
                                    radiusM: reach.radiusM,
                                ))
                            }
                            saving = false
                            if failure == nil { dismiss() }
                        }
                    } label: {
                        if saving { ProgressView() } else { Text("Sichern") }
                    }
                    .disabled(saving || place == nil || !hoursAddUp)
                }
            }
            .onAppear(perform: adoptCurrent)
        }
    }

    /// How much of the destination the day is about.
    ///
    /// Three choices, not a field in metres: nobody plans a day in
    /// metres. The sentence below the picker says what the chosen one
    /// does, because "Ortskern" and "Gegend" are only labels until
    /// something says what changes.
    private var reachSection: some View {
        Section {
            Picker("Umkreis", selection: $reach.animation()) {
                ForEach(TripOutingReach.allCases) { option in
                    Text(option.label).tag(option)
                }
            }
            .pickerStyle(.segmented)
        } header: {
            Text("Wie weit")
        } footer: {
            Text(reach.explanation)
        }
    }

    /// The two hours, each behind its own switch.
    ///
    /// Off by default, because the ordinary case is a day trip nobody
    /// has timed yet — and an hour the app filled in for them would be
    /// a claim about their day rather than a question about it.
    private var hours: some View {
        Section {
            Toggle("Abfahrt angeben", isOn: $saysDeparture.animation())
            if saysDeparture {
                DatePicker("Abfahrt", selection: $departure, displayedComponents: .hourAndMinute)
                if let arrival = estimatedArrival {
                    LabeledContent("Ankunft geschätzt", value: arrival)
                        .foregroundStyle(.secondary)
                }
            }
            Toggle("Rückfahrt angeben", isOn: $saysReturn.animation())
            if saysReturn {
                DatePicker("Rückfahrt um", selection: $back, displayedComponents: .hourAndMinute)
            }
            if !hoursAddUp {
                Label("Die Rückfahrt liegt vor der Abfahrt.", systemImage: "exclamationmark.triangle")
                    .foregroundStyle(.orange)
                    .font(.footnote)
            }
        } header: {
            Text("Zeiten")
        } footer: {
            // Why anybody would bother: the estimate is arithmetic on a
            // straight line, and a named hour is not.
            Text("Freiwillig. Ohne Angabe schätzt der Planer die Fahrzeit — grob, ohne "
                 + "Routenplaner. Mit Abfahrt startet der Tag ab dort, mit Rückfahrt plant "
                 + "er nichts mehr dahinter.")
        }
    }

    /// The window of an excursion: both hours, and what the drive makes
    /// of them (Mock 16 B).
    private var windowHours: some View {
        Section {
            DatePicker("Abfahrt an der Unterkunft", selection: $departure, displayedComponents: .hourAndMinute)
            if let travel = travelMinutes, travel > 0, let depart = departMinutes {
                LabeledContent("Ankunft am Ziel", value: "ca. \(TripClock.format(depart + travel))")
                    .foregroundStyle(.secondary)
            }
            DatePicker("Rückfahrt um", selection: $back, displayedComponents: .hourAndMinute)
            if let travel = travelMinutes, travel > 0, let home = returnMinutes {
                LabeledContent("Zurück an der Unterkunft", value: "ca. \(TripClock.format(home + travel))")
                    .foregroundStyle(.secondary)
            }
            if !hoursAddUp {
                Label("Die Rückfahrt liegt vor der Abfahrt.", systemImage: "exclamationmark.triangle")
                    .foregroundStyle(.orange)
                    .font(.footnote)
            }
        } header: {
            Text("Zeiten")
        } footer: {
            Text("Die Fahrzeit schätzt die App, solange ein Ziel noch neu ist; nach dem Sichern steht sie hier.")
        }
    }

    /// The one part still guessed once a departure is named — shown
    /// rather than hidden, so a wrong estimate is visible instead of
    /// turning up later as a shorter afternoon.
    ///
    /// Only for a destination the server has already measured: the app
    /// does not own a travel model, and inventing one here would be a
    /// second set of answers.
    private var estimatedArrival: String? {
        TripOutingHours.arrival(departMinutes: departMinutes, travelMinutes: travelMinutes)
    }

    /// Refused here rather than by the server, so nobody watches a
    /// spinner to be told the obvious.
    private var hoursAddUp: Bool {
        TripOutingHours.addUp(depart: departMinutes, back: returnMinutes)
    }

    /// Re-open the sheet on a day that already has an outing, and it
    /// shows that outing: the place and both hours.
    ///
    /// Starting empty was worse than it looked. "Ändern" gave a blank
    /// search field, so changing only the return hour meant finding
    /// Pisa again — and leaving without searching would have saved the
    /// day away from the place it was already on.
    private func adoptCurrent() {
        if let excursion {
            span = .window
            place = TripPlace(name: excursion.displayName, subtitle: nil,
                              latitude: excursion.lat, longitude: excursion.lon)
            reach = TripOutingReach.of(radiusM: excursion.radiusM)
            departure = Self.at(hour: excursion.departMinutes / 60, minute: excursion.departMinutes % 60)
            back = Self.at(hour: excursion.returnMinutes / 60, minute: excursion.returnMinutes % 60)
            return
        }
        if onSaveWindow != nil && (current != nil || !allowsWholeDay) {
            span = current != nil && allowsWholeDay ? .wholeDay : .window
        }
        if span == .window && current == nil {
            departure = Self.defaultWindowDeparture
            back = Self.defaultWindowReturn
        }
        guard let current else { return }
        place = current.place
        reach = TripOutingReach.of(radiusM: current.radiusM)
        if let minutes = current.departMinutes {
            saysDeparture = true
            departure = Self.at(hour: minutes / 60, minute: minutes % 60)
        }
        if let minutes = current.returnMinutes {
            saysReturn = true
            back = Self.at(hour: minutes / 60, minute: minutes % 60)
        }
    }
}

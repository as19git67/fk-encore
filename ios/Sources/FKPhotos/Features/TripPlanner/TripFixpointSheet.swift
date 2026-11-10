import SwiftUI

/// Saying a hard time out loud (§4.4).
///
/// The concept keeps clock times off the plan on purpose — a day is
/// blocks, not a timetable — with one exception it names itself: the
/// last train, the booked slot, check-in from three. Those are the
/// **frame**, and the frame is the one thing the planner may not guess.
///
/// Two kinds, and the difference decides what the rest of the day looks
/// like: after an appointment you come back and the afternoon goes on;
/// after a departure you are gone, and everything behind it is a
/// promise nobody can keep.
struct TripFixpointSheet: View {
    let dayLabel: String
    /// The spots an appointment can be for — the leg's planned stops and
    /// candidates. Empty hides the choice.
    var spots: [TripSpotChoice] = []
    /// Opened from a spot ("Feste Zeit eintragen …"): that spot is chosen and
    /// the appointment is called after it.
    var presetSpot: TripSpotChoice? = nil
    /// Opened away from a day (from the candidates): which days the
    /// appointment can go on. Empty means the day the sheet was opened
    /// for, named by `dayLabel`.
    var days: [TripDayChoice] = []
    var presetDayIndex: Int? = nil
    let onSave: (Draft) async -> Void

    /// What the sheet hands back.
    ///
    /// A struct rather than six positional arguments: the place was the
    /// sixth, and a sixth `Int` in a row nobody can read is how a
    /// coordinate ends up in the buffer.
    struct Draft {
        let label: String
        let minutesOfDay: Int
        let kind: String
        let travelMinutes: Int
        let durationMinutes: Int
        /// Where it happens, when somebody said (§4.4). Optional, and
        /// the whole point of it: a located fixpoint at one end of the
        /// day moves the day's route.
        let place: TripPlace?
        /// The spot of the trip this appointment is for, if any — the
        /// plan then puts it at this hour and nowhere else.
        var spotRef: String? = nil
        /// Why the spot has this time — only with `spotRef`.
        var pinReason: TripPinReason? = nil
        /// The day, when the sheet offered a choice; nil for the day it
        /// was opened on.
        var dayIndex: Int? = nil
    }

    @State private var finder = TripPlaceFinderModel()
    @State private var place: TripPlace?
    /// See `TripDayAnchorSheet.changingPlace`.
    @State private var changingPlace = false
    @State private var label = ""
    @State private var kind = Kind.departure
    @State private var time = Self.defaultTime
    @State private var travelMinutes = 15
    @State private var durationMinutes = 60
    @State private var saving = false
    @State private var spot: TripSpotChoice?
    @State private var pinReason: TripPinReason = .ticket
    @State private var dayIndex = 0
    @State private var seeded = false
    @Environment(\.dismiss) private var dismiss

    /// What "Sichern" saves as the name: the one typed, or the spot's.
    private var effectiveLabel: String {
        let typed = label.trimmingCharacters(in: .whitespacesAndNewlines)
        if !typed.isEmpty { return typed }
        return kind == .appointment ? (spot?.name ?? "") : ""
    }

    private var headerLabel: String {
        days.first { $0.dayIndex == dayIndex }?.label ?? dayLabel
    }

    enum Kind: String, CaseIterable {
        case departure
        case appointment

        var label: String {
            switch self {
            case .departure:   return "Abfahrt"
            case .appointment: return "Termin"
            }
        }
    }

    /// True when the plan measures the way instead of taking a number.
    ///
    /// A located departure ends the day's route at that place, so the
    /// walk is computed from the stop the day really ends at. Asking
    /// for it as a stepper as well would subtract the same minutes a
    /// second time — which is exactly what it did for one day.
    private var routePaysTheWay: Bool {
        kind == .departure && place != nil
    }

    /// 17:45 — the shape of the case this exists for. A default of
    /// "now" would be a time nobody means.
    static var defaultTime: Date {
        Calendar.current.date(bySettingHour: 17, minute: 45, second: 0, of: Date()) ?? Date()
    }

    /// Opened from a spot: only what a fixed time of that spot needs.
    /// The spot is where it happens and the way there is the day's, so
    /// the kind, the place and the way are not asked (Anton, 10.11.).
    private var forSpot: Bool { presetSpot != nil }

    /// A spot's fixed time: when, on which day, why, and how long.
    @ViewBuilder
    private var spotForm: some View {
        Section {
            DatePicker("Uhrzeit", selection: $time, displayedComponents: .hourAndMinute)
            if days.count > 1 {
                Picker("Tag", selection: $dayIndex) {
                    ForEach(days) { day in
                        Text(day.label).tag(day.dayIndex)
                    }
                }
            }
        } header: {
            Text(presetSpot?.name ?? "Spot")
        } footer: {
            Text("Zu dieser Uhrzeit steht der Spot fest im Tag, auf keinem anderen Tag, "
                 + "und die App plant den Rest um ihn herum.")
        }
        Section {
            Picker("Warum fest?", selection: $pinReason) {
                ForEach(TripPinReason.allCases) { reason in
                    Label(reason.label, systemImage: reason.systemImage).tag(reason)
                }
            }
        }
        Section {
            Stepper(value: $durationMinutes, in: 0...480, step: 15) {
                Text(TripClock.duration(durationMinutes))
            }
        } header: {
            Text("Dauer")
        } footer: {
            Text("Wie lange ihr dort seid.")
        }
    }

    var body: some View {
        NavigationStack {
            Form {
              if forSpot {
                spotForm
              } else {
                Section {
                    Picker("Art", selection: $kind) {
                        ForEach(Kind.allCases, id: \.self) { kind in
                            Text(kind.label).tag(kind)
                        }
                    }
                    .pickerStyle(.segmented)
                } footer: {
                    Text(kind == .departure
                         ? "Nach der Abfahrt ist der Tag vorbei — der Planer rechnet von hier "
                           + "rückwärts und plant nichts dahinter."
                         : "Nach einem Termin geht der Tag weiter. Der Planer hält die Zeit frei "
                           + "und plant um sie herum.")
                }

                if kind == .appointment, !spots.isEmpty {
                    Section {
                        NavigationLink {
                            TripSpotPickAndReturn(spots: spots, selected: spot?.osmRef) { picked in
                                spot = picked
                            }
                            .navigationTitle("Spot für den Termin")
                        } label: {
                            LabeledContent("Spot", value: spot?.name ?? "Keiner")
                        }
                        if spot != nil {
                            Picker("Warum fest?", selection: $pinReason) {
                                ForEach(TripPinReason.allCases) { reason in
                                    Label(reason.label, systemImage: reason.systemImage).tag(reason)
                                }
                            }
                        }
                    } footer: {
                        Text(spot == nil
                             ? "Ein Ticket für eine Sehenswürdigkeit? Mit dem Spot steht sie zur "
                               + "Uhrzeit im Tag und wird nicht noch einmal eingeplant."
                             : "Der Spot steht zur Uhrzeit des Termins im Tag, angeheftet, und "
                               + "verschwindet von jedem anderen Tag.")
                    }
                }

                if days.count > 1 {
                    Section {
                        Picker("Tag", selection: $dayIndex) {
                            ForEach(days) { day in
                                Text(day.label).tag(day.dayIndex)
                            }
                        }
                    }
                }

                Section {
                    TextField(kind == .departure
                              ? "Letzter Zug"
                              : (spot?.name ?? "Führung, Tischreservierung …"),
                              text: $label)
                    DatePicker("Uhrzeit", selection: $time, displayedComponents: .hourAndMinute)
                } header: {
                    Text(headerLabel)
                } footer: {
                    if effectiveLabel.isEmpty {
                        // Why "Sichern" is grey — said next to the field,
                        // not left to be guessed.
                        Text("Ein Name ist nötig, damit die Zeit im Tag wiederzuerkennen ist.")
                    }
                }

                if kind == .departure, durationMinutes > 0 {
                    Section {
                        Text("Eine Abfahrt ist ein Zeitpunkt — die eingetragene Dauer von "
                             + "\(TripClock.duration(durationMinutes)) entfällt.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }

                if kind == .appointment {
                    Section {
                        Stepper(value: $durationMinutes, in: 0...480, step: 15) {
                            Text(TripClock.duration(durationMinutes))
                        }
                    } header: {
                        Text("Dauer")
                    } footer: {
                        Text("Wie lange der Termin selbst dauert. Diese Zeit ist für den Planer "
                             + "belegt.")
                    }
                }

                Section {
                    if let place, !changingPlace {
                        HStack {
                            Label(place.name, systemImage: "mappin.circle.fill")
                                .lineLimit(2)
                            Spacer()
                            Button("Ändern") { changingPlace = true }
                                .buttonStyle(.borderless)
                                .font(.footnote)
                        }
                    } else {
                        TripPlaceFinderRows(model: finder, picked: nil) { picked in
                            place = picked
                            changingPlace = false
                            if label.trimmingCharacters(in: .whitespaces).isEmpty {
                                label = picked.name
                            }
                        }
                        if place != nil {
                            Button("Doch behalten") { changingPlace = false }
                                .font(.footnote)
                        }
                    }
                } header: {
                    Text("Wo")
                } footer: {
                    // This is the half that does something, so it says
                    // what: the day is routed from or to this point
                    // instead of from and to the accommodation.
                    Text(kind == .departure
                         ? "Bahnhof, Flughafen, Hafen. Mit einem Ort hier endet der letzte Block "
                           + "dort statt an der Unterkunft — den Rückweg ins Hotel geht ja niemand "
                           + "mehr."
                         : "Wenn der Termin vor dem ersten Block liegt — die Ankunft —, startet "
                           + "der Tag von hier statt von der Unterkunft. Ohne Ort bleibt alles "
                           + "wie bisher.")
                }

                if !routePaysTheWay {
                    Section {
                        Stepper(value: $travelMinutes, in: 0...240, step: 5) {
                            Text(TripClock.duration(travelMinutes))
                        }
                    } header: {
                        Text("Weg dorthin")
                    } footer: {
                        // The buffer is the server's business and never
                        // zero (§4.4) — said here so nobody wonders
                        // where the missing quarter hour went.
                        Text("Vom Plan aus hin. Ein Puffer von 20 Minuten kommt automatisch "
                             + "dazu — einen Zug zu verpassen kostet mehr als einen "
                             + "ausgelassenen Ort.")
                    }
                } else {
                    Section {
                        Label("Der Weg wird gerechnet", systemImage: "figure.walk")
                            .foregroundStyle(.secondary)
                    } footer: {
                        // Asking for it as well would take the same
                        // minutes off the day twice.
                        Text("Vom letzten Stopp des Tages zum genannten Ort — dafür ist die "
                             + "Adresse da. Der Puffer von 20 Minuten kommt weiterhin dazu.")
                    }
                }
              }
            }
            .navigationTitle("Feste Zeit")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Abbrechen") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        saving = true
                        Task {
                            await onSave(Draft(
                                label: effectiveLabel,
                                minutesOfDay: TripDayTimeline.minutesOfDay(time),
                                kind: kind.rawValue,
                                travelMinutes: routePaysTheWay ? 0 : travelMinutes,
                                durationMinutes: durationMinutes,
                                place: forSpot ? nil : place,
                                spotRef: kind == .appointment ? spot?.osmRef : nil,
                                pinReason: kind == .appointment && spot != nil ? pinReason : nil,
                                dayIndex: days.isEmpty ? nil : dayIndex,
                            ))
                            saving = false
                            dismiss()
                        }
                    } label: {
                        if saving { ProgressView() } else { Text("Sichern") }
                    }
                    .disabled(saving || effectiveLabel.isEmpty)
                }
            }
            .onAppear {
                guard !seeded else { return }
                seeded = true
                if let presetSpot {
                    spot = presetSpot
                    kind = .appointment
                    time = Calendar.current.date(bySettingHour: 14, minute: 0, second: 0, of: Date()) ?? time
                }
                dayIndex = presetDayIndex ?? days.first?.dayIndex ?? 0
            }
        }
    }
}

/// A day an appointment can go on, when the sheet is opened away from
/// the day itself.
struct TripDayChoice: Identifiable, Hashable {
    let dayIndex: Int
    let label: String

    var id: Int { dayIndex }
}

/// The spot list pushed from the sheet: picking goes back to the form.
private struct TripSpotPickAndReturn: View {
    let spots: [TripSpotChoice]
    let selected: String?
    let onPick: (TripSpotChoice?) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        TripSpotPickerList(spots: spots, selected: selected) { picked in
            onPick(picked)
            dismiss()
        }
    }
}

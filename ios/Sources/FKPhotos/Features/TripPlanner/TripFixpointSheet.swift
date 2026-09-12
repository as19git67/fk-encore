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
    }

    @State private var finder = TripPlaceFinderModel()
    @State private var place: TripPlace?
    @State private var label = ""
    @State private var kind = Kind.departure
    @State private var time = Self.defaultTime
    @State private var travelMinutes = 15
    @State private var durationMinutes = 60
    @State private var saving = false
    @Environment(\.dismiss) private var dismiss

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

    /// 17:45 — the shape of the case this exists for. A default of
    /// "now" would be a time nobody means.
    static var defaultTime: Date {
        Calendar.current.date(bySettingHour: 17, minute: 45, second: 0, of: Date()) ?? Date()
    }

    var body: some View {
        NavigationStack {
            Form {
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

                Section {
                    TextField(kind == .departure ? "Letzter Zug" : "Führung, Tischreservierung …",
                              text: $label)
                    DatePicker("Uhrzeit", selection: $time, displayedComponents: .hourAndMinute)
                } header: {
                    Text(dayLabel)
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
                    if let place {
                        HStack {
                            Label(place.name, systemImage: "mappin.circle.fill")
                                .lineLimit(2)
                            Spacer()
                            Button("Ändern") { self.place = nil }
                                .buttonStyle(.borderless)
                                .font(.footnote)
                        }
                    } else {
                        TripPlaceFinderRows(model: finder, picked: nil) { picked in
                            place = picked
                            if label.trimmingCharacters(in: .whitespaces).isEmpty {
                                label = picked.name
                            }
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

                Section {
                    Stepper(value: $travelMinutes, in: 0...240, step: 5) {
                        Text(TripClock.duration(travelMinutes))
                    }
                } header: {
                    Text("Weg dorthin")
                } footer: {
                    // The buffer is the server's business and never
                    // zero (§4.4) — said here so nobody wonders where
                    // the missing quarter hour went.
                    Text("Vom Plan aus hin. Ein Puffer von 20 Minuten kommt automatisch dazu — "
                         + "einen Zug zu verpassen kostet mehr als einen ausgelassenen Spot.")
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
                                label: label.trimmingCharacters(in: .whitespacesAndNewlines),
                                minutesOfDay: TripDayTimeline.minutesOfDay(time),
                                kind: kind.rawValue,
                                travelMinutes: travelMinutes,
                                durationMinutes: durationMinutes,
                                place: place,
                            ))
                            saving = false
                            dismiss()
                        }
                    } label: {
                        if saving { ProgressView() } else { Text("Sichern") }
                    }
                    .disabled(saving || label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }
}

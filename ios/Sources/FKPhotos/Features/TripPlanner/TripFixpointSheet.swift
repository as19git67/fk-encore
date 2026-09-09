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
    let onSave: (String, Int, String, Int, Int) async -> Void

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
                            await onSave(
                                label.trimmingCharacters(in: .whitespacesAndNewlines),
                                TripDayTimeline.minutesOfDay(time),
                                kind.rawValue,
                                travelMinutes,
                                durationMinutes,
                            )
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

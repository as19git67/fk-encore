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
    let onSave: (Draft?) async -> Void

    /// What the sheet hands back — the place and, if anybody said, the
    /// two hours that frame the outing.
    struct Draft {
        let place: TripPlace
        /// Minutes past midnight, or nil when the traveller left the
        /// switch off: an hour nobody meant is worse than no hour.
        let departMinutes: Int?
        let returnMinutes: Int?
    }

    @State private var finder = TripPlaceFinderModel()
    @State private var place: TripPlace?
    @State private var saysDeparture = false
    @State private var saysReturn = false
    @State private var departure = Self.defaultDeparture
    @State private var back = Self.defaultReturn
    @State private var saving = false
    @Environment(\.dismiss) private var dismiss

    /// 8:30 out, 17:30 back — the shape of a day trip. "Now" would be a
    /// time nobody means.
    static var defaultDeparture: Date { at(hour: 8, minute: 30) }
    static var defaultReturn: Date { at(hour: 17, minute: 30) }

    private static func at(hour: Int, minute: Int) -> Date {
        Calendar.current.date(bySettingHour: hour, minute: minute, second: 0, of: Date()) ?? Date()
    }

    private var departMinutes: Int? {
        saysDeparture ? TripDayTimeline.minutesOfDay(departure) : nil
    }

    private var returnMinutes: Int? {
        saysReturn ? TripDayTimeline.minutesOfDay(back) : nil
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    if let place {
                        HStack {
                            Label(place.name, systemImage: "mappin.circle.fill").lineLimit(2)
                            Spacer()
                            Button("Ändern") { self.place = nil }
                                .buttonStyle(.borderless)
                                .font(.footnote)
                        }
                    } else {
                        TripPlaceFinderRows(model: finder, picked: nil) { picked in
                            place = picked
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

                hours

                if let current {
                    Section {
                        Button(role: .destructive) {
                            saving = true
                            Task {
                                await onSave(nil)
                                saving = false
                                dismiss()
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
                        Task {
                            await onSave(Draft(
                                place: place,
                                departMinutes: departMinutes,
                                returnMinutes: returnMinutes,
                            ))
                            saving = false
                            dismiss()
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

    /// The one part still guessed once a departure is named — shown
    /// rather than hidden, so a wrong estimate is visible instead of
    /// turning up later as a shorter afternoon.
    ///
    /// Only for a destination the server has already measured: the app
    /// does not own a travel model, and inventing one here would be a
    /// second set of answers.
    private var estimatedArrival: String? {
        TripOutingHours.arrival(departMinutes: departMinutes, travelMinutes: current?.travelMinutes)
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
        guard let current else { return }
        place = current.place
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

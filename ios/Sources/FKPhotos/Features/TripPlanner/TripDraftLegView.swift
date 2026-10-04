import SwiftUI

/// One further city of a trip being drafted (§4.2).
///
/// The same four things the first city has — a place, a length, a way
/// of getting around, a radius — plus the one a first city cannot have:
/// **the journey into it**. That is not decoration. A transfer frames
/// both days it touches: leaving at 09:30 takes the evening off the day
/// before, arriving at 14:00 takes the morning off the day you land.
/// A planner that ignores it promises two days nobody has.
///
/// Both times are optional and independent, because that is how they
/// are actually known: the flight is booked long before anybody works
/// out when they will leave the flat.
///
/// `extra` is what a caller adds below the shared fields — the add-city
/// form puts the date there, which a city drafted with the trip takes
/// from the trip instead.
struct TripDraftLegView<Extra: View>: View {
    @Binding var leg: TripDraftLeg
    let position: Int
    /// What the city before this one is called, for the transfer's
    /// wording. Nil while it is still unpicked.
    let previousName: String?
    @ViewBuilder var extra: () -> Extra

    @State private var finder = TripPlaceFinderModel()

    var body: some View {
        Form {
            Section {
                TripPlaceFinderRows(model: finder, picked: leg.place) { place in
                    leg.place = place
                    finder.query = place.name
                    finder.clearResults()
                }
                if leg.place != nil {
                    TextField("Stadt (optional)", text: $leg.title)
                        .textInputAutocapitalization(.words)
                    Toggle("Noch nichts gebucht", isOn: $leg.anchorIsApproximate)
                    if leg.anchorIsApproximate {
                        TripRadiusPicker(metres: $leg.anchorRadiusM)
                    }
                    Toggle("Unterkunft fährt mit", isOn: $leg.quartersAboard)
                    if leg.quartersAboard {
                        Toggle("Tenderhafen", isOn: $leg.tenderPort)
                    }
                }
            } header: {
                Text("Unterkunft")
            } footer: {
                Text(leg.quartersAboard
                     ? "Ein Hafentag: Die Unterkunft ist der Liegeplatz, und die Abfahrt heißt "
                       + "„Alle an Bord“ mit einer Stunde Puffer — in einem Tenderhafen anderthalb."
                     : "Hotel, Campingplatz oder Adresse — hier fängt jeder Tag dieser Stadt "
                       + "an und hier endet er.")
            }

            Section {
                Stepper(value: $leg.days,
                        in: TripNewPlanDraft.minDays...TripNewPlanDraft.maxDays) {
                    Text(leg.days == 1 ? "1 Tag" : "\(leg.days) Tage")
                }
                TripTransportModePicker(mode: $leg.mode)
            } header: {
                Text("Hier")
            }

            Section {
                // Only the arrival: the way here — when the group leaves
                // the city before, what it sees on the road — is a
                // journey of its own (§22.7), made in the city list once
                // the trip exists. Two places to say the same thing was
                // what nobody could tell apart.
                optionalTime("Ankunft", binding: $leg.arriveAt, defaultHour: 14)
            } header: {
                Text("Ankunft in dieser Stadt")
            } footer: {
                Text("Freiwillig. Vor der Ankunft fängt der erste Tag nicht an. Die Fahrt "
                     + "selbst — Abfahrt, Dauer, Orte am Weg — ist eine Weiterreise: die fügst du "
                     + "nach dem Anlegen in der Städteliste zwischen zwei Städten ein.")
            }

            extra()
        }
        .navigationTitle(leg.effectiveTitle ?? "Stadt \(position + 1)")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            if let name = leg.place?.name, finder.query.isEmpty { finder.query = name }
        }
    }

    /// A time that may simply not be known yet.
    ///
    /// A `DatePicker` cannot express "unknown", and defaulting it to
    /// midnight would put a departure on the plan that nobody said —
    /// which is exactly the invented fact §15.3 forbids. So the toggle
    /// carries the knowledge and the picker only the hour.
    @ViewBuilder
    private func optionalTime(
        _ label: String,
        binding: Binding<Date?>,
        defaultHour: Int,
    ) -> some View {
        Toggle(label, isOn: Binding(
            get: { binding.wrappedValue != nil },
            set: { on in
                binding.wrappedValue = on
                    ? (binding.wrappedValue ?? Self.today(at: defaultHour))
                    : nil
            },
        ))
        if let value = binding.wrappedValue {
            DatePicker(
                "Uhrzeit",
                selection: Binding(get: { value }, set: { binding.wrappedValue = $0 }),
                displayedComponents: .hourAndMinute,
            )
        }
    }

    private static func today(at hour: Int) -> Date {
        Calendar.current.date(bySettingHour: hour, minute: 0, second: 0, of: Date()) ?? Date()
    }
}

extension TripDraftLegView where Extra == EmptyView {
    /// The shared fields alone, for the trip draft.
    init(leg: Binding<TripDraftLeg>, position: Int, previousName: String?) {
        self.init(leg: leg, position: position, previousName: previousName) { EmptyView() }
    }
}

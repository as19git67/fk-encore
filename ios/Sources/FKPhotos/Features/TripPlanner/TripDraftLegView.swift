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
struct TripDraftLegView: View {
    @Binding var leg: TripDraftLeg
    let position: Int
    /// What the city before this one is called, for the transfer's
    /// wording. Nil while it is still unpicked.
    let previousName: String?

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
                        Stepper(value: $leg.anchorRadiusM, in: 300...10_000, step: 250) {
                            Text("Ungefähr im Umkreis von \(leg.anchorRadiusM) m")
                        }
                    }
                }
            } header: {
                Text("Unterkunft")
            } footer: {
                Text("Hotel, Campingplatz oder Adresse — hier fängt jeder Tag dieser Stadt "
                     + "an und hier endet er.")
            }

            Section {
                Stepper(value: $leg.days,
                        in: TripNewPlanDraft.minDays...TripNewPlanDraft.maxDays) {
                    Text(leg.days == 1 ? "1 Tag" : "\(leg.days) Tage")
                }
                Picker("Unterwegs", selection: $leg.mode) {
                    ForEach(TripTransportMode.allCases, id: \.self) { mode in
                        Label(mode.label, systemImage: mode.systemImage).tag(mode)
                    }
                }
                Text(leg.mode.hint)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } header: {
                Text("Hier")
            }

            Section {
                optionalTime("Abfahrt \(fromWhere)", binding: $leg.departAt, defaultHour: 9)
                optionalTime("Ankunft", binding: $leg.arriveAt, defaultHour: 14)
            } header: {
                Text("Die Fahrt dorthin")
            } footer: {
                Text("Beides ist freiwillig. Was angegeben ist, wird zum Fixpunkt: nach der "
                     + "Abfahrt ist der Tag vorbei, vor der Ankunft fängt der nächste nicht an.")
            }
        }
        .navigationTitle(leg.effectiveTitle ?? "Stadt \(position + 1)")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            if let name = leg.place?.name, finder.query.isEmpty { finder.query = name }
        }
    }

    private var fromWhere: String {
        previousName.map { "aus \($0)" } ?? "aus der Stadt davor"
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

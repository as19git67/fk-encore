import SwiftUI

/// The one way the app asks how a trip gets about: on foot, by bike,
/// by tram or by car.
///
/// A row that says what is chosen and leads to a page of choices, the
/// way the system's own settings do. Two earlier shapes did not
/// survive the road: the menu a `Form` gives a picker by default drew
/// the chosen `Label` as its button, and on iOS 17 and 18 only that
/// symbol took the tap; the inline list of four rows worked but made
/// every "Wie?" section a column of options. A settings row is one
/// line at rest and the whole screen when you want to change it.
///
/// One component for the five screens that ask (new plan, new city,
/// changing a city, the plan's settings, a journey), so the question
/// looks the same wherever it is put. It needs a navigation stack
/// around it, which every one of those screens has.
struct TripTransportModePicker: View {
    @Binding var mode: TripTransportMode
    /// What may be chosen: a place's four, or every mode for a journey,
    /// which is the only thing that goes by ship (§21.3).
    var choices: [TripTransportMode] = TripTransportMode.forPlaces

    var body: some View {
        NavigationLink {
            TripTransportModeChoiceView(mode: $mode, choices: choices)
        } label: {
            LabeledContent("Fortbewegung") {
                Label(mode.label, systemImage: mode.systemImage)
            }
        }
    }
}

/// The page of choices behind the row: one line per mode, its hint
/// under it, a tick on the chosen one. Choosing does not pop the page —
/// the tick moves, and the back button is where it always is.
struct TripTransportModeChoiceView: View {
    @Binding var mode: TripTransportMode
    var choices: [TripTransportMode] = TripTransportMode.forPlaces

    var body: some View {
        List {
            Section {
                ForEach(choices, id: \.self) { candidate in
                    Button {
                        mode = candidate
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Label(candidate.label, systemImage: candidate.systemImage)
                                Text(candidate.hint)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            .foregroundStyle(.primary)
                            Spacer()
                            if candidate == mode {
                                Image(systemName: "checkmark")
                                    .fontWeight(.semibold)
                                    .foregroundStyle(.tint)
                                    .accessibilityHidden(true)
                            }
                        }
                    }
                    .accessibilityAddTraits(candidate == mode ? .isSelected : [])
                }
            } footer: {
                Text("Der Planer rechnet damit, wie weit ein Spot vom nächsten liegen "
                     + "darf und was in einen Tag passt.")
            }
        }
        .navigationTitle("Fortbewegung")
        .navigationBarTitleDisplayMode(.inline)
    }
}

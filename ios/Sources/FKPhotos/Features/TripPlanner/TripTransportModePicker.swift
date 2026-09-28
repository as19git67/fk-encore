import SwiftUI

/// The one way the app asks how a trip gets about: on foot, by bike,
/// by tram or by car.
///
/// Drawn inline — four rows with a tick — rather than as the menu a
/// `Form` would give a picker by default. The menu drew the chosen
/// `Label` as its button, and on iOS 17 and 18 that button, not the
/// row, was what took the tap: a finger on the words did nothing, a
/// finger on the symbol opened the menu. Four choices fit in a
/// section, every row is tappable end to end, and the symbol and the
/// wording stay side by side — which a segmented control would have
/// reduced to symbols alone.
///
/// One component for the five screens that ask (new plan, new city,
/// changing a city, the plan's settings, a journey), so the question
/// looks the same wherever it is put.
struct TripTransportModePicker: View {
    @Binding var mode: TripTransportMode

    var body: some View {
        Picker("Unterwegs", selection: $mode) {
            ForEach(TripTransportMode.allCases, id: \.self) { candidate in
                Label(candidate.label, systemImage: candidate.systemImage).tag(candidate)
            }
        }
        .pickerStyle(.inline)
    }
}

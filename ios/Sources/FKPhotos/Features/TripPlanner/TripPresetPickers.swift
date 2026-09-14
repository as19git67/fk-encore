import SwiftUI

/// A duration, chosen from the values people actually mean, then
/// fine-tuned.
///
/// The stepper alone went from 45 to 240 minutes in thirty-nine taps.
/// The chips are the answer nine times out of ten; the stepper stays
/// for the tenth.
struct TripDurationPicker: View {
    @Binding var minutes: Int
    var range: ClosedRange<Int> = 5...480
    var step: Int = 5

    private static let presets: [(label: String, minutes: Int)] = [
        ("30 Min", 30), ("1 h", 60), ("2 h", 120), ("Halber Tag", 240),
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                ForEach(Self.presets, id: \.minutes) { preset in
                    Button(preset.label) { minutes = preset.minutes }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .tint(minutes == preset.minutes ? .accentColor : .secondary)
                }
            }
            Stepper(value: $minutes, in: range, step: step) {
                Text(TripClock.duration(minutes))
            }
        }
    }
}

/// A radius in metres, the same way: presets first, stepper second.
struct TripRadiusPicker: View {
    @Binding var metres: Int
    var range: ClosedRange<Int> = 300...10_000
    var step: Int = 250

    private static let presets: [(label: String, metres: Int)] = [
        ("500 m", 500), ("1 km", 1_000), ("3 km", 3_000), ("5 km", 5_000),
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                ForEach(Self.presets, id: \.metres) { preset in
                    Button(preset.label) { metres = preset.metres }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .tint(metres == preset.metres ? .accentColor : .secondary)
                }
            }
            Stepper(value: $metres, in: range, step: step) {
                Text("Ungefähr im Umkreis von \(Self.format(metres))")
            }
        }
    }

    static func format(_ metres: Int) -> String {
        metres >= 1_000
            ? String(format: "%.1f km", Double(metres) / 1_000).replacingOccurrences(of: ".0 km", with: " km")
            : "\(metres) m"
    }
}

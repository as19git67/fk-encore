import SwiftUI

/// Which spot of the trip a fixed appointment is for (§4.4).
///
/// The ticket for the tower at 14:00 is a time *and* a place the trip
/// already knows — as a candidate, or already planned on some day. The
/// list shows both, and where each sits now, so picking the one on
/// Tuesday is a decision rather than a surprise: once picked, it moves
/// to the appointment and leaves Tuesday.
struct TripSpotPickerList: View {
    let spots: [TripSpotChoice]
    let selected: String?
    let onPick: (TripSpotChoice?) -> Void

    @State private var query = ""

    private var filtered: [TripSpotChoice] {
        let needle = query.trimmingCharacters(in: .whitespaces)
        guard !needle.isEmpty else { return spots }
        return spots.filter { $0.name.localizedCaseInsensitiveContains(needle) }
    }

    var body: some View {
        List {
            Section {
                row(title: "Kein Spot", subtitle: "Nur die Zeit freihalten", isSelected: selected == nil) {
                    onPick(nil)
                }
            }
            Section {
                ForEach(filtered) { spot in
                    row(title: spot.name,
                        subtitle: spot.plannedOn.map { "eingeplant: \($0)" } ?? "Kandidat",
                        isSelected: selected == spot.osmRef) {
                        onPick(spot)
                    }
                }
            } footer: {
                Text("Der Spot steht dann zur Uhrzeit des Termins im Tag, angeheftet — und wird "
                     + "an keinem anderen Tag noch einmal eingeplant.")
            }
        }
        .searchable(text: $query, prompt: "Spot suchen")
    }

    private func row(title: String, subtitle: String, isSelected: Bool,
                     action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).foregroundStyle(.primary)
                    Text(subtitle).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                if isSelected {
                    Image(systemName: "checkmark").foregroundStyle(.tint)
                }
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

/// Tying an appointment that is already on the day to a spot — the
/// ticket entered as a time before anybody thought of the place.
struct TripFixpointSpotSheet: View {
    let fixpoint: TripFixpoint
    let spots: [TripSpotChoice]
    let onPick: (String?) async -> Void

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            TripSpotPickerList(spots: spots, selected: fixpoint.spotRef) { picked in
                Task {
                    if picked?.osmRef != fixpoint.spotRef {
                        await onPick(picked?.osmRef)
                    }
                    dismiss()
                }
            }
            .navigationTitle("\(fixpoint.label) · \(fixpoint.startsAt)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Abbrechen") { dismiss() }
                }
            }
        }
    }
}

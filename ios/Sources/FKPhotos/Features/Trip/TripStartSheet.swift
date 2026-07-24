import SwiftUI

/// Sheet shown when starting a trip. Etappe 1b-i: the user confirms/edits the
/// trip name (default „Trip <Datum>"). Etappe 1b-ii adds a location-based
/// name suggestion and the geofence.
struct TripStartSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var name: String = TripStore.defaultTripName()

    /// Called with the confirmed name when the user taps „Starten".
    let onStart: (String) -> Void

    private var canStart: Bool {
        !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Trip-Name", text: $name)
                } header: {
                    Text("Name")
                } footer: {
                    Text("Neue Fotos werden automatisch in ein Album mit diesem Namen synchronisiert. Ein iOS- und ein Server-Album werden bei Bedarf angelegt.")
                }
            }
            .navigationTitle("Trip starten")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Abbrechen") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Starten") {
                        onStart(name)
                        dismiss()
                    }
                    .disabled(!canStart)
                }
            }
        }
    }
}

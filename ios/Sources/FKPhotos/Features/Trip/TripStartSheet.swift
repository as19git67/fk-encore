import SwiftUI

/// Sheet shown when starting a trip. Confirms/edits the trip name and — since
/// Etappe 1b-ii — suggests a name from the current location (reverse-geocoded).
///
/// The start location is used for the **name only**. It used to also become an
/// inclusion geofence, which quietly broke every trip that travelled more than
/// its radius away from where Trip Mode was switched on; membership is the time
/// window minus the home exclusion zone now (see `ActiveTrip.homeExclusion`).
struct TripStartSheet: View {
    @Environment(\.dismiss) private var dismiss

    private let initialName: String
    @State private var name: String
    @State private var isLocating = false
    @State private var placeName: String?
    @State private var locationProvider = TripLocationProvider()

    /// Called with the confirmed name.
    let onStart: (String) -> Void

    /// - Parameter suggestedName: Prefill from the auto-start suggestion
    ///   (`docs/ios-trip-mode.md` §9.2), derived from where the recent photos
    ///   were taken. `nil` for a manual start, which falls back to the
    ///   date-based default. Either way the live location below may still
    ///   refine it — the suggestion's coordinate comes from a photo cluster,
    ///   the sheet's from the device standing right there.
    init(suggestedName: String? = nil, onStart: @escaping (String) -> Void) {
        self.onStart = onStart
        let initial = suggestedName ?? TripStore.defaultTripName()
        self.initialName = initial
        _name = State(initialValue: initial)
    }

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

                Section {
                    if isLocating {
                        HStack(spacing: 8) {
                            ProgressView()
                            Text("Ort wird ermittelt …")
                                .foregroundStyle(.secondary)
                        }
                    } else if let placeName {
                        Label("Startort: \(placeName)", systemImage: "location.fill")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    } else {
                        Label("Kein Ort verfügbar – nur für den Namensvorschlag nötig", systemImage: "location.slash")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                } footer: {
                    Text("Alle Fotos, die du ab jetzt unterwegs aufnimmst, zählen zum Trip – egal wie weit du dich vom Startort entfernst. Nur Fotos, die zuhause entstehen, bleiben außen vor.")
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
            .task { await suggestFromLocation() }
        }
    }

    /// Fetches the current location and — only if the user hasn't edited the
    /// name yet — prefills a place-based suggestion like „Gardasee (Juli 2026)".
    private func suggestFromLocation() async {
        isLocating = true
        defer { isLocating = false }

        guard let location = await locationProvider.currentLocation(),
              let place = await locationProvider.placeName(for: location) else { return }
        placeName = place

        // Only replace the name while it still holds the untouched default, so a
        // name the user already typed is never overwritten.
        guard name == initialName else { return }
        name = "\(place) (\(Self.monthYear()))"
    }

    private static func monthYear() -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "MMMM yyyy"
        return formatter.string(from: Date())
    }
}

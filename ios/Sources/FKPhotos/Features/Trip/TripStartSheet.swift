import SwiftUI

/// Sheet shown when starting a trip. Confirms/edits the trip name and — since
/// Etappe 1b-ii — suggests a name from the current location (reverse-geocoded)
/// and captures a geofence around it.
struct TripStartSheet: View {
    @Environment(\.dismiss) private var dismiss

    /// Default geofence radius around the start location. Time-window remains
    /// the primary membership rule; the geofence is a refinement (Etappe 1c).
    private static let defaultRadiusMeters: Double = 25_000

    private let initialName = TripStore.defaultTripName()
    @State private var name: String
    @State private var isLocating = false
    @State private var geofence: ActiveTrip.Geofence?
    @State private var locationProvider = TripLocationProvider()

    /// Called with the confirmed name and the (optional) geofence.
    let onStart: (String, ActiveTrip.Geofence?) -> Void

    init(onStart: @escaping (String, ActiveTrip.Geofence?) -> Void) {
        self.onStart = onStart
        _name = State(initialValue: TripStore.defaultTripName())
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
                    } else if geofence != nil {
                        Label("Ort erfasst – nur Fotos in der Nähe zählen zum Trip", systemImage: "location.fill")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    } else {
                        Label("Kein Ort verfügbar – der Trip nutzt nur das Zeitfenster", systemImage: "location.slash")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
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
                        onStart(name, geofence)
                        dismiss()
                    }
                    .disabled(!canStart)
                }
            }
            .task { await suggestFromLocation() }
        }
    }

    /// Fetches the current location, sets the geofence around it, and — only if
    /// the user hasn't edited the name yet — prefills a place-based suggestion
    /// like „Gardasee (Juli 2026)".
    private func suggestFromLocation() async {
        isLocating = true
        defer { isLocating = false }

        guard let location = await locationProvider.currentLocation() else { return }
        geofence = ActiveTrip.Geofence(
            latitude: location.coordinate.latitude,
            longitude: location.coordinate.longitude,
            radiusMeters: Self.defaultRadiusMeters
        )

        // Only replace the name while it still holds the untouched default, so a
        // name the user already typed is never overwritten.
        guard name == initialName else { return }
        if let place = await locationProvider.placeName(for: location) {
            name = "\(place) (\(Self.monthYear()))"
        }
    }

    private static func monthYear() -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "MMMM yyyy"
        return formatter.string(from: Date())
    }
}

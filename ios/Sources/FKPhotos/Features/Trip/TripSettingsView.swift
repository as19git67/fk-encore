import CoreLocation
import SwiftUI

/// Everything about trips in one place.
///
/// The maps app lived under "Profil", the suggestion switch under
/// "Foto-Synchronisierung", and the home location nowhere at all —
/// three screens for one subject, none pointing at the others. This is
/// the one entry, linked from the Settings tab and from the Trip tab.
struct TripSettingsView: View {
    @AppStorage(TripSuggestionSettings.enabledKey) private var tripSuggestions = true
    /// Bumped after a reset so the count row re-reads.
    @State private var refreshTick = 0
    @State private var homeName: String?
    @State private var homeResolved = false
    @State private var locationProvider = TripLocationProvider()

    private var suppressedRegionCount: Int {
        _ = refreshTick
        return TripRegionSuppression.suppressedRegions.count
    }

    var body: some View {
        List {
            Section {
                NavigationLink {
                    TripMapsSettingsView()
                } label: {
                    LabeledContent("Karten-App") {
                        Text(TripMapsPreference.load().label)
                            .foregroundStyle(.secondary)
                    }
                }
            } footer: {
                Text("Womit Routen, ganze Blöcke und Orte geöffnet werden.")
            }

            Section {
                Toggle("Trip-Vorschläge", isOn: $tripSuggestions)
                if tripSuggestions, suppressedRegionCount > 0 {
                    Button("Ausgeblendete Gegenden zurücksetzen (\(suppressedRegionCount))") {
                        TripRegionSuppression.resetAll()
                        refreshTick += 1
                    }
                }
            } header: {
                Text("Vorschläge")
            } footer: {
                Text("Die App schlägt vor, einen Trip zu starten, wenn deine Fotos zeigen, dass "
                     + "du weit weg von zuhause bist – und ihn zu beenden, wenn du wieder da bist. "
                     + "Vorgeschlagen wird nur; gestartet und beendet wird nie von selbst. Gegenden, "
                     + "die du oft besuchst, werden mit der Zeit nicht mehr vorgeschlagen.")
            }

            Section {
                if !homeResolved {
                    HStack(spacing: 8) {
                        ProgressView()
                        Text("Wird ermittelt …").foregroundStyle(.secondary)
                    }
                } else if let homeName {
                    LabeledContent("Zuhause", value: homeName)
                    LabeledContent("Umkreis",
                                   value: "\(Int(TripAutoEndPreferences.homeArrivalRadiusMeters / 1000)) km")
                } else {
                    Label("Noch nicht bestimmt", systemImage: "house.slash")
                        .foregroundStyle(.secondary)
                }
            } header: {
                Text("Zuhause")
            } footer: {
                Text("Aus den Aufnahmeorten deiner Fotos abgeleitet, nicht eingegeben. Fotos aus "
                     + "diesem Umkreis kommen nicht in ein Trip-Album, und hier fragt die App, ob "
                     + "der Trip zu Ende ist. Solange es nicht bestimmt ist, gibt es keinen "
                     + "Vorschlag, den Trip zu beenden.")
            }
        }
        .navigationTitle("Trip & Reise")
        .navigationBarTitleDisplayMode(.inline)
        .task { await resolveHome() }
    }

    private func resolveHome() async {
        defer { homeResolved = true }
        guard let coordinate = await TripHomeLocation.resolve() else { return }
        let location = CLLocation(latitude: coordinate.latitude, longitude: coordinate.longitude)
        homeName = await locationProvider.placeName(for: location)
            ?? String(format: "%.3f, %.3f", coordinate.latitude, coordinate.longitude)
    }
}

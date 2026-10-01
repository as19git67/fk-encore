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
    @State private var userHome: TripHome?
    @State private var homeFinder = TripPlaceFinderModel()
    @State private var savingUserHome = false
    @State private var userHomeError: String?

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
                // Said once, copied into every new trip (§22.7): the far
                // end of the way there and the way home.
                if let userHome {
                    HStack {
                        Label(userHome.displayLabel, systemImage: "house")
                        Spacer()
                        Button("Entfernen") { Task { await clearUserHome() } }
                            .buttonStyle(.borderless)
                            .disabled(savingUserHome)
                    }
                } else {
                    TripPlaceFinderRows(model: homeFinder, picked: nil) { place in
                        homeFinder.clearResults()
                        Task { await saveUserHome(place) }
                    }
                }
                if let userHomeError {
                    Text(userHomeError)
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
            } header: {
                Text("Wohnort")
            } footer: {
                Text("Von hier geht jede neue Reise los, und hierher zurück: Anreise und "
                     + "Heimreise lassen sich damit wie eine Weiterreise planen. Eine Reise kann "
                     + "ein eigenes Zuhause bekommen; das hier ändert keine, die es schon gibt.")
            }

            Section {
                NavigationLink {
                    TripRoutingMeasureView()
                } label: {
                    Label("Reisezeiten prüfen", systemImage: "arrow.triangle.swap")
                }
            } header: {
                Text("Routing")
            } footer: {
                Text("Vergleicht die geschätzten Reisezeiten deiner geplanten Tage mit dem "
                     + "Routing-Dienst und sagt, ob sich echte Reisezeiten im Plan lohnen.")
            }

            Section {
                if !homeResolved {
                    HStack(spacing: 8) {
                        ProgressView()
                        Text("Wird ermittelt …").foregroundStyle(.secondary)
                    }
                } else if let homeName {
                    LabeledContent("Erkannt", value: homeName)
                    LabeledContent("Umkreis",
                                   value: "\(Int(TripAutoEndPreferences.homeArrivalRadiusMeters / 1000)) km")
                } else {
                    Label("Noch nicht bestimmt", systemImage: "house.slash")
                        .foregroundStyle(.secondary)
                }
            } header: {
                Text("Zuhause aus den Fotos")
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
        .task { userHome = await TripUserHome.load() }
    }

    private func saveUserHome(_ place: TripPlace) async {
        savingUserHome = true
        defer { savingUserHome = false }
        do {
            userHome = try await TripUserHome.save(place)
            userHomeError = nil
        } catch {
            userHomeError = TripErrorText.describe(error)
        }
    }

    private func clearUserHome() async {
        savingUserHome = true
        defer { savingUserHome = false }
        do {
            try await TripUserHome.clear()
            userHome = nil
            userHomeError = nil
        } catch {
            userHomeError = TripErrorText.describe(error)
        }
    }

    private func resolveHome() async {
        defer { homeResolved = true }
        guard let coordinate = await TripHomeLocation.resolve() else { return }
        let location = CLLocation(latitude: coordinate.latitude, longitude: coordinate.longitude)
        homeName = await locationProvider.placeName(for: location)
            ?? String(format: "%.3f, %.3f", coordinate.latitude, coordinate.longitude)
    }
}

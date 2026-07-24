import SwiftUI

/// Entry point of the "Trip" tab.
///
/// Etappe 1a (dieser Stand) liefert nur die Navigations-/UI-Struktur: der Tab
/// ersetzt den früheren Personen-Tab (Personen ist jetzt eine Spezial-Zeile in
/// „Alben"). Die eigentliche Trip-Mechanik — Trip starten/beenden,
/// Foto-Grid, Optionen (Modus, Auto/Manuell), Geofence + Auto-Name — kommt in
/// den Etappen 1b/1c (siehe `docs/ios-trip-mode.md`).
struct TripView: View {
    var body: some View {
        ContentUnavailableView {
            Label("Trip Mode", systemImage: "map")
        } description: {
            Text("Neue Fotos automatisch in ein gemeinsames Reise-Album synchronisieren – ohne vorher ein Album anzulegen. Kommt in Kürze.")
        }
        .navigationTitle("Trip")
        .navigationBarTitleDisplayMode(.inline)
    }
}

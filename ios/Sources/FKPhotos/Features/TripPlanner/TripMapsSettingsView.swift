import SwiftUI
import UIKit

/// "Navigation öffnen mit" (§9.1).
///
/// The concept is explicit that this is the user's choice, not ours:
/// plenty of people navigate with Google Maps out of habit, especially
/// abroad where its transit data is often better. The mechanics have
/// been in place since the handoff was built; this is the switch that
/// was missing, without which the stored preference could never leave
/// its default.
///
/// The choice governs **every** handoff in §9.1, not just navigation:
/// looking a spot up and finding somewhere to eat follow it too.
struct TripMapsSettingsView: View {
    @AppStorage(TripMapsPreference.key) private var stored: String = TripMapsApp.apple.rawValue

    /// Checked once, when the screen appears: `canOpenURL` is cheap but
    /// not free, and an app cannot be installed while this view is up
    /// without the view being rebuilt anyway.
    @State private var googleInstalled = false

    private var selection: Binding<TripMapsApp> {
        Binding(
            get: { TripMapsApp(rawValue: stored) ?? .apple },
            set: { stored = $0.rawValue },
        )
    }

    var body: some View {
        List {
            Section {
                Picker("Navigation öffnen mit", selection: selection) {
                    Text(TripMapsApp.apple.label).tag(TripMapsApp.apple)
                    if googleInstalled {
                        Text(TripMapsApp.google.label).tag(TripMapsApp.google)
                        Text(TripMapsApp.ask.label).tag(TripMapsApp.ask)
                    }
                }
                .pickerStyle(.inline)
                .labelsHidden()
            } footer: {
                Text(googleInstalled
                     ? "Gilt für alles, was an eine Karten-App übergeben wird: Navigation, "
                       + "ganze Blöcke, Orte nachschlagen und die Essensliste."
                     : "Google Maps ist auf diesem Gerät nicht installiert. Sobald es da ist, "
                       + "erscheint es hier zur Auswahl.")
            }

            if !googleInstalled, currentIsGoogle {
                Section {
                    // The setting can outlive the app being uninstalled.
                    // Saying so is better than silently opening Apple
                    // Maps and letting the traveller wonder.
                    Label(
                        "Eingestellt ist Google Maps, das gerade fehlt — bis dahin öffnet "
                            + "sich Apple Karten.",
                        systemImage: "exclamationmark.triangle",
                    )
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                }
            }
        }
        .navigationTitle("Karten-App")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            googleInstalled = UIApplication.shared.canOpenURL(
                URL(string: "\(TripMapsApp.googleScheme)://")!,
            )
        }
    }

    private var currentIsGoogle: Bool {
        (TripMapsApp(rawValue: stored) ?? .apple) == .google
    }
}

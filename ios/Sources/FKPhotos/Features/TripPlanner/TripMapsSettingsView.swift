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
                // All three, always: the one you chose must stay visible
                // even when Google Maps is not installed right now.
                Picker("Navigation öffnen mit", selection: selection) {
                    ForEach(TripMapsApp.allCases, id: \.self) { app in
                        Text(app.label).tag(app)
                    }
                }
                .pickerStyle(.inline)
            } header: {
                Text("Navigation öffnen mit")
            } footer: {
                Text("Routen und ganze Blöcke folgen dieser Wahl; bei „Jedes Mal fragen“ "
                     + "fragt der Dialog auch nach „immer“. Einen Ort nachschlagen öffnet die "
                     + "gewählte App, sonst Apple Karten.")
            }

            if !googleInstalled, currentNeedsGoogle {
                Section {
                    // The setting can outlive the app being uninstalled.
                    // Saying so is better than silently opening Apple
                    // Maps and letting the traveller wonder.
                    Label(
                        "Google Maps ist auf diesem Gerät nicht installiert — bis es da ist, "
                            + "öffnet sich Apple Karten.",
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

    private var currentNeedsGoogle: Bool {
        (TripMapsApp(rawValue: stored) ?? .apple) != .apple
    }
}

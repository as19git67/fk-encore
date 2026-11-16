import SwiftUI

/// Taking the trip along without a connection (§3.9).
///
/// One screen with one decision on it: keep this plan on the phone, or
/// don't. It is deliberately a thing somebody asks for rather than
/// something that happens by itself — a plan that silently downloaded
/// itself would also silently be the plan being shown, and then nobody
/// could tell whether they were looking at today's or Tuesday's.
///
/// The screen is as honest about the gaps as about the contents (§14):
/// there is no map offline, and no forecast, because a three-day-old
/// "trocken" on a wet morning is worse than saying nothing.
struct TripOfflineView: View {
    @State var viewModel: TripPlannerViewModel
    @State private var justSaved = false
    @AppStorage(TripOfflineAutoLoad.settingKey) private var autoLoad = true

    var body: some View {
        List {
            Section {
                if let storedAt = viewModel.bundleStoredAt {
                    VStack(alignment: .leading, spacing: 2) {
                        Label("Auf dem Gerät", systemImage: "checkmark.circle")
                        Text(TripOfflineWording.stamp(storedAt))
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                        if let bytes = viewModel.offlineStore.sizeBytes(planId: viewModel.planId) {
                            Text(TripOfflineWording.size(bytes))
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    }
                } else {
                    Label("Nicht auf dem Gerät", systemImage: "icloud.slash")
                        .foregroundStyle(.secondary)
                }

                Button {
                    Task { justSaved = await viewModel.downloadBundle() }
                } label: {
                    if viewModel.isDownloadingBundle {
                        ProgressView()
                    } else {
                        Label(viewModel.bundleStoredAt == nil ? "Für unterwegs laden"
                                                              : "Auf neuesten Stand bringen",
                              systemImage: "arrow.down.circle")
                    }
                }
                .disabled(viewModel.isDownloadingBundle)

                if viewModel.bundleStoredAt != nil {
                    Button("Vom Gerät löschen", role: .destructive) {
                        viewModel.removeBundle()
                        justSaved = false
                    }
                }
            } header: {
                Text("Ohne Netz")
            } footer: {
                Text("Auf dem iPhone liegt danach die ganze Reise: Reiseverlauf, Aufenthalte, "
                     + "Tage, Spots, Ideen, die Bilder der Spots, das Licht der ausgeplanten "
                     + "Tage und die Dokumente der Reise als PDF. Jede Änderung kommt von selbst "
                     + "nach. Ohne Netz steht die Reise in der Liste, und die App zeigt diesen "
                     + "Stand und sagt, von wann er ist. Abhaken geht auch ohne Netz; das und "
                     + "erkannte Besuche schickt sie nach, sobald wieder Netz da ist.\n\nNicht "
                     + "dabei sind die Karte in der App und die Wettervorhersage. Die Route öffnet "
                     + "Apple Karten, das mit seinen eigenen Offline-Karten weiter funktioniert. "
                     + "Planen und ändern geht nur mit Verbindung.")
            }

            Section {
                Toggle("Anstehende Reisen von selbst laden", isOn: $autoLoad)
            } footer: {
                Text("Eine Reise, die in den nächsten \(TripOfflineAutoLoad.daysAhead) Tagen beginnt "
                     + "oder gerade läuft, lädt die App im WLAN von selbst für unterwegs, wenn "
                     + "genug Platz ist. Löschst du sie hier vom Gerät, bleibt sie gelöscht, "
                     + "bis du sie wieder lädst.")
            }

            if justSaved {
                Section {
                    Label("Gespeichert. Die Reise steht jetzt auch im Flugmodus in der Liste.",
                          systemImage: "checkmark.seal")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }

        }
        .navigationTitle("Unterwegs ohne Netz")
        .plannerErrorBanner(viewModel.errorMessage, dismiss: { viewModel.errorMessage = nil })
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// The line over a screen that shows what is kept on the phone (§3.9):
/// that it is offline, and from when the shown state is. Without it a
/// plan from Tuesday looked exactly like the plan from now. A tap asks
/// the server again, for when the network is back.
struct TripOfflineBar: View {
    let since: Date
    let retry: () -> Void

    var body: some View {
        Button(action: retry) {
            HStack(spacing: 8) {
                Image(systemName: "wifi.slash")
                VStack(alignment: .leading, spacing: 1) {
                    Text("Offline · \(TripOfflineWording.stamp(since))")
                        .font(.footnote.weight(.semibold))
                    Text("Ändern geht erst wieder mit Verbindung.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                Image(systemName: "arrow.clockwise")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.orange.opacity(0.12))
        }
        .buttonStyle(.plain)
        .accessibilityHint("Neu laden")
    }
}

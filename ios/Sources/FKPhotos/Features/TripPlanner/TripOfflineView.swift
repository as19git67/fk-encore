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
                Text("Geladen werden alle Etappen, Tage, Blöcke, Spots, der Vorrat und die "
                     + "Lichtfenster der ausgeplanten Tage. Nicht dabei: die Karte und die "
                     + "Wettervorhersage — eine drei Tage alte Vorhersage wäre schlechter als "
                     + "gar keine.\n\nÄndern lässt sich ein Plan nur mit Verbindung. Ohne Netz "
                     + "zeigt der Tagesplan, was gespeichert ist, und sagt, von wann es ist.")
            }

            if justSaved {
                Section {
                    Label("Gespeichert. Der Plan ist jetzt auch im Flugmodus da.",
                          systemImage: "checkmark.seal")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }

            if let message = viewModel.errorMessage {
                Section {
                    Text(message).font(.footnote).foregroundStyle(.red)
                }
            }
        }
        .navigationTitle("Unterwegs ohne Netz")
        .navigationBarTitleDisplayMode(.inline)
    }
}

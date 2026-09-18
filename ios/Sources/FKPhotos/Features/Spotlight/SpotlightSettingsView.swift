import SwiftUI

/// Einstellungen → Suche auf dem Gerät (#768, further idea 2).
///
/// Two switches, deliberately separate: names and album titles are harmless
/// in the system search; recognised photo text is opt-in because it is the
/// kind of content — letters, invoices, business cards — a phone search then
/// shows as snippets to whoever holds the phone.
struct SpotlightSettingsView: View {
    @State private var indexer = SpotlightIndexer.shared
    @State private var photoText = SpotlightPreferences.photoTextEnabled
    @State private var peopleAndAlbums = SpotlightPreferences.peopleAndAlbumsEnabled

    var body: some View {
        Form {
            Section {
                Toggle(isOn: $peopleAndAlbums) {
                    Label("Personen und Alben", systemImage: "person.2")
                }
                .onChange(of: peopleAndAlbums) { _, enabled in
                    SpotlightPreferences.peopleAndAlbumsEnabled = enabled
                    if !enabled {
                        Task {
                            await indexer.wipe(.person)
                            await indexer.wipe(.album)
                        }
                    }
                }
            } footer: {
                Text("Namen und Albumtitel erscheinen in der Suche des iPhones. Beim nächsten Öffnen der Listen wird der Index aufgefrischt.")
            }

            Section {
                Toggle(isOn: $photoText) {
                    Label("Text in Fotos", systemImage: "text.viewfinder")
                }
                .onChange(of: photoText) { _, enabled in
                    SpotlightPreferences.photoTextEnabled = enabled
                    Task {
                        if enabled {
                            await indexer.syncPhotos(force: true)
                        } else {
                            await indexer.wipe(.photo)
                        }
                    }
                }
                if photoText {
                    LabeledContent("Im Index") {
                        Text(indexer.indexedPhotoCount == 1 ? "1 Foto" : "\(indexer.indexedPhotoCount) Fotos")
                    }
                    if indexer.isIndexingPhotos {
                        HStack {
                            ProgressView()
                            Text("Wird aufgebaut…")
                                .foregroundStyle(.secondary)
                        }
                    } else if let last = indexer.lastPhotoRun {
                        LabeledContent("Zuletzt") {
                            Text(last, format: .relative(presentation: .named))
                        }
                    }
                    if let error = indexer.lastError {
                        Text(error)
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                    Button("Jetzt aktualisieren") {
                        Task { await indexer.syncPhotos(force: true) }
                    }
                    .disabled(indexer.isIndexingPhotos)
                }
            } footer: {
                Text("Fotos mit erkanntem Text oder einer Beschreibung — ein Schild, eine Speisekarte, eine Notiz — werden über diesen Text in der iPhone-Suche gefunden. Der Index bleibt auf diesem Gerät. Erkannter Text kann persönliche Angaben enthalten, etwa aus fotografierten Briefen; deshalb ist das aus, bis du es einschaltest.")
            }
        }
        .navigationTitle("Suche auf dem iPhone")
        .navigationBarTitleDisplayMode(.inline)
    }
}

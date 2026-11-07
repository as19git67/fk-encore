import MusicKit
import SwiftUI

/// Profil → Musik in Rückblicken: Apple Music on or off.
///
/// Off by default. Switching it on asks iOS for access to Apple Music and
/// the music library once; without a subscription the recaps keep the
/// license-free music.
struct RecapMusicSettingsView: View {
    @State private var enabled = AppleMusicPreferences.enabled
    @State private var status = MusicAuthorization.currentStatus
    @State private var canPlay: Bool?

    var body: some View {
        Form {
            Section {
                Toggle(isOn: $enabled) {
                    Label("Apple Music verwenden", systemImage: "music.note")
                }
                .onChange(of: enabled) { _, on in
                    Task { await setEnabled(on) }
                }
                if enabled {
                    LabeledContent("Abo") {
                        switch canPlay {
                        case .none: ProgressView()
                        case .some(true): Text("aktiv")
                        case .some(false): Text("nicht gefunden").foregroundStyle(.secondary)
                        }
                    }
                }
                if status == .denied || status == .restricted {
                    Text("Der Zugriff auf Apple Music ist in den iOS-Einstellungen nicht erlaubt (Einstellungen › Datenschutz & Sicherheit › Medien & Apple Music).")
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
            } footer: {
                Text("Mit einem Apple-Music-Abo spielen Rückblicke Musik aus deinem Abo: zuerst Titel, die du um die Zeit des Rückblicks deiner Mediathek hinzugefügt hast, sonst eine Playlist von Apple Music zur Stimmung des Rückblicks. Im Rückblick kannst du über „Playlist wählen“ eine eigene Playlist festlegen. Die Musik läuft nur in der App; exportierte oder geteilte Videos behalten die lizenzfreie Musik.")
            }
        }
        .navigationTitle("Musik in Rückblicken")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if enabled { canPlay = await RecapAppleMusic.canPlayCatalog() }
        }
    }

    private func setEnabled(_ on: Bool) async {
        guard on else {
            AppleMusicPreferences.enabled = false
            return
        }
        status = await RecapAppleMusic.requestAccess()
        guard status == .authorized else {
            enabled = false
            AppleMusicPreferences.enabled = false
            return
        }
        AppleMusicPreferences.enabled = true
        canPlay = nil
        canPlay = await RecapAppleMusic.canPlayCatalog()
    }
}

/// "Playlist wählen" in the recap player: a playlist from the user's own
/// library for this recap, or back to the automatic pick.
struct RecapPlaylistPicker: View {
    let selectedId: String?
    let load: () async -> [RecapLibraryPlaylist]
    let onPick: (String?) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var playlists: [RecapLibraryPlaylist]?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    row(title: "Automatisch", subtitle: "Musik aus der Zeit oder zur Stimmung", id: nil)
                }
                Section("Deine Playlists") {
                    if let playlists {
                        if playlists.isEmpty {
                            Text("Keine Playlists in deiner Mediathek.")
                                .foregroundStyle(.secondary)
                        }
                        ForEach(playlists) { playlist in
                            row(title: playlist.name, subtitle: nil, id: playlist.id)
                        }
                    } else {
                        ProgressView()
                    }
                }
            }
            .navigationTitle("Playlist wählen")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Abbrechen") { dismiss() }
                }
            }
            .task { playlists = await load() }
        }
    }

    private func row(title: String, subtitle: String?, id: String?) -> some View {
        Button {
            onPick(id)
            dismiss()
        } label: {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).foregroundStyle(.primary)
                    if let subtitle {
                        Text(subtitle).font(.caption).foregroundStyle(.secondary)
                    }
                }
                Spacer()
                if selectedId == id {
                    Image(systemName: "checkmark").foregroundStyle(.tint)
                }
            }
        }
    }
}

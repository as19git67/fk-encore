import SwiftUI

/// Einstellungen → Benachrichtigungen (#765): the push switch for this
/// phone, and the per-kind preferences the web's profile page also edits
/// (`GET/PUT /push/preferences`) — one set of preferences for every device,
/// so turning off "Favoriten" here turns it off in the browser too.
struct PushSettingsView: View {
    @State private var manager = RemotePushManager.shared
    @State private var pushEnabled = RemotePushPreferences.isEnabled
    @State private var prefs = NotificationPrefsModel()
    /// Whether new similar-photo groups are announced (#968) — a local
    /// notification, but it belongs on the same screen.
    @State private var reviewNotificationsEnabled = ReviewQueueNotificationPreferences.isEnabled

    var body: some View {
        Form {
            Section {
                Toggle(isOn: $pushEnabled) {
                    Label("Push auf diesem iPhone", systemImage: "bell.badge")
                }
                .disabled(manager.serverEnabled == false)
                .onChange(of: pushEnabled) { _, enabled in
                    Task {
                        if enabled { await manager.enable() } else { await manager.disable() }
                    }
                }
                statusRow
            } footer: {
                Text(footerText)
            }

            Section("Benachrichtigen bei") {
                if prefs.isLoading && prefs.kinds.isEmpty {
                    ProgressView()
                } else {
                    ForEach(NotificationPrefsModel.photoKinds, id: \.kind) { entry in
                        Toggle(isOn: prefs.binding(for: entry.kind)) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(entry.label)
                                Text(entry.description)
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                if let error = prefs.errorMessage {
                    Text(error).font(.footnote).foregroundStyle(.red)
                }
            }

            Section {
                Toggle(isOn: $reviewNotificationsEnabled) {
                    Label("Hinweis auf neue Gruppen", systemImage: "checklist")
                }
                .onChange(of: reviewNotificationsEnabled) { _, enabled in
                    ReviewQueueNotificationPreferences.isEnabled = enabled
                }
            } footer: {
                Text("Eine lokale Mitteilung nach dem Sync, wenn neue ähnliche Fotos auf eine Entscheidung warten. Braucht keinen Server-Push.")
            }
        }
        .navigationTitle("Benachrichtigungen")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await manager.refreshServerStatus()
            await prefs.load()
        }
    }

    @ViewBuilder
    private var statusRow: some View {
        switch manager.state {
        case .on:
            Label("Aktiv", systemImage: "checkmark.circle").foregroundStyle(.secondary)
        case .registering:
            HStack { ProgressView(); Text("Wird registriert…").foregroundStyle(.secondary) }
        case .denied:
            VStack(alignment: .leading, spacing: 6) {
                Text("Mitteilungen sind für F4mil Photos in den iOS-Einstellungen ausgeschaltet.")
                    .font(.footnote)
                Button("Einstellungen öffnen") {
                    if let url = URL(string: UIApplication.openSettingsURLString) {
                        UIApplication.shared.open(url)
                    }
                }
                .font(.footnote)
            }
        case .failed(let message):
            Text(message).font(.footnote).foregroundStyle(.red)
        case .off, .unavailable:
            EmptyView()
        }
    }

    private var footerText: String {
        if manager.serverEnabled == false {
            return "Der Server ist nicht für Push an iPhones eingerichtet (APNS_* in der Server-Konfiguration). Im Browser kann Push trotzdem aktiv sein."
        }
        return "Kommentare, neue Fotos in geteilten Alben und Freigaben kommen als Mitteilung an, auch wenn die App geschlossen ist. Ein Tipp öffnet die Stelle in der App. Solange du in der App bist, wird nichts geschickt."
    }
}

/// The per-kind preferences, shared with the web (`users.notification_prefs`).
@MainActor
@Observable
final class NotificationPrefsModel {
    struct Kind {
        let kind: String
        let label: String
        let description: String
    }

    /// The photo kinds, in the web profile's order and wording. Document
    /// and receipt kinds are left to the web: the app has no documents.
    static let photoKinds: [Kind] = [
        Kind(kind: "photo_added", label: "Neue Fotos", description: "Jemand hat Fotos zu einem geteilten Album hinzugefügt"),
        Kind(kind: "album_shared", label: "Album geteilt", description: "Jemand hat ein Album mit dir geteilt"),
        Kind(kind: "photo_commented", label: "Kommentare", description: "Jemand hat ein Foto kommentiert"),
        Kind(kind: "photo_favorited", label: "Favoriten", description: "Jemand hat ein Foto favorisiert"),
        Kind(kind: "album_left", label: "Freigabe verlassen", description: "Jemand hat eine Albumfreigabe verlassen"),
    ]

    private(set) var kinds: [String: Bool] = [:]
    private(set) var isLoading = false
    var errorMessage: String?

    private struct Envelope: Codable { let preferences: [String: Bool] }

    func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let response: Envelope = try await APIClient.shared.get("/push/preferences")
            kinds = response.preferences
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Absent means enabled, as on the server (`isKindEnabled`).
    func binding(for kind: String) -> Binding<Bool> {
        Binding(
            get: { self.kinds[kind] ?? true },
            set: { enabled in
                self.kinds[kind] = enabled
                Task { await self.save() }
            }
        )
    }

    private func save() async {
        do {
            let _: Envelope = try await APIClient.shared.put("/push/preferences", body: Envelope(preferences: kinds))
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

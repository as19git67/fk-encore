import SwiftUI

struct AdminView: View {
    @Environment(AuthManager.self) private var authManager

    var body: some View {
        List {
            // Profile section
            if let user = authManager.currentUser {
                Section("Profil") {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(user.name)
                            .font(.title2.bold())
                        Text(user.email)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                        if !user.roles.isEmpty {
                            HStack {
                                ForEach(user.roles) { role in
                                    Text(role.name)
                                        .font(.caption)
                                        .padding(.horizontal, 8)
                                        .padding(.vertical, 2)
                                        .background(.blue.opacity(0.15))
                                        .clipShape(Capsule())
                                }
                            }
                        }
                    }
                    .padding(.vertical, 4)
                }
            }

            // Admin section (visible to all, backend handles permissions)
            Section("Verwaltung") {
                NavigationLink {
                    UsersListView()
                } label: {
                    Label("Benutzer", systemImage: "person.2")
                }

                NavigationLink {
                    RolesView()
                } label: {
                    Label("Rollen & Berechtigungen", systemImage: "lock.shield")
                }
            }

            // Settings
            Section("Einstellungen") {
                NavigationLink {
                    SyncSettingsView()
                } label: {
                    Label("Foto-Synchronisierung", systemImage: "arrow.triangle.2.circlepath")
                }

                NavigationLink {
                    ServerSettingsView()
                } label: {
                    Label("Server-Verbindung", systemImage: "server.rack")
                }
            }

            // Logout
            Section {
                Button(role: .destructive) {
                    Task { await authManager.logout() }
                } label: {
                    Label("Abmelden", systemImage: "rectangle.portrait.and.arrow.right")
                }
            }
        }
        .navigationTitle("Profil")
    }
}

struct ServerSettingsView: View {
    @AppStorage(APIClient.serverURLKey) private var serverURL: String = "http://localhost:4000"
    @State private var isSaved = false

    var body: some View {
        Form {
            Section("API Server") {
                TextField("Server URL", text: $serverURL)
                    .keyboardType(.URL)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)

                Button("Speichern") {
                    if let url = URL(string: serverURL) {
                        Task {
                            await APIClient.shared.setBaseURL(url)
                            isSaved = true
                        }
                    }
                }
            }

            if isSaved {
                Section {
                    Label("Gespeichert", systemImage: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                }
            }
        }
        .navigationTitle("Server")
        .navigationBarTitleDisplayMode(.inline)
    }
}

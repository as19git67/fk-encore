import SwiftUI

struct AlbumShareView: View {
    let albumId: Int
    @State private var viewModel: AlbumShareViewModel
    @State private var selectedUserId: Int? = nil
    @State private var selectedAccessLevel = "read"
    @State private var linkExpiry: String? = nil
    @State private var showErrorAlert = false
    @State private var copiedToClipboard = false
    @Environment(\.dismiss) private var dismiss
    @AppStorage(APIClient.serverURLKey) private var serverURL: String = "http://localhost:4000"

    init(albumId: Int) {
        self.albumId = albumId
        _viewModel = State(initialValue: AlbumShareViewModel(albumId: albumId))
    }

    var publicLinkURL: String? {
        guard let link = viewModel.publicLink else { return nil }
        return "\(serverURL)/albums/public/\(link.token)"
    }

    // Exclude users already having a share
    var availableUsers: [UserWithRoles] {
        let sharedIds = Set(viewModel.shares.map { $0.user_id })
        return viewModel.users.filter { !sharedIds.contains($0.id) }
    }

    var body: some View {
        NavigationStack {
            List {
                userSharesSection
                publicLinkSection
            }
            .navigationTitle("Freigabe")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Fertig") { dismiss() }
                }
            }
            .task {
                async let shares: () = viewModel.loadShares()
                async let users: () = viewModel.loadUsers()
                _ = await (shares, users)
            }
            .alert("Fehler", isPresented: $showErrorAlert) {
                Button("OK", role: .cancel) { viewModel.errorMessage = nil }
            } message: {
                Text(viewModel.errorMessage ?? "")
            }
            .onChange(of: viewModel.errorMessage) { _, newValue in
                if newValue != nil { showErrorAlert = true }
            }
        }
    }

    // MARK: - User Shares Section

    @ViewBuilder
    private var userSharesSection: some View {
        Section {
            // Add-user controls
            if viewModel.isLoadingUsers {
                ProgressView("Benutzer laden…")
                    .frame(maxWidth: .infinity, alignment: .center)
            } else if viewModel.usersLoadFailed {
                Label("Benutzerliste nicht verfügbar", systemImage: "exclamationmark.triangle")
                    .foregroundStyle(.secondary)
                    .font(.subheadline)
            } else if viewModel.users.isEmpty {
                Text("Keine anderen Benutzer vorhanden")
                    .foregroundStyle(.secondary)
                    .font(.subheadline)
            } else {
                Picker("Benutzer", selection: $selectedUserId) {
                    Text("Benutzer wählen…").tag(Optional<Int>.none)
                    ForEach(availableUsers) { user in
                        VStack(alignment: .leading) {
                            Text(user.name)
                            Text(user.email).font(.caption).foregroundStyle(.secondary)
                        }
                        .tag(Optional(user.id))
                    }
                }

                Picker("Zugriff", selection: $selectedAccessLevel) {
                    Text("Nur lesen").tag("read")
                    Text("Bearbeiten").tag("write")
                }
                .pickerStyle(.segmented)

                Button {
                    guard let userId = selectedUserId else { return }
                    Task {
                        await viewModel.shareWithUser(userId: userId, accessLevel: selectedAccessLevel)
                        if viewModel.errorMessage == nil {
                            selectedUserId = nil
                        }
                    }
                } label: {
                    if viewModel.isSubmitting {
                        ProgressView()
                            .frame(maxWidth: .infinity, alignment: .center)
                    } else {
                        Label("Hinzufügen", systemImage: "person.badge.plus")
                            .frame(maxWidth: .infinity, alignment: .center)
                    }
                }
                .disabled(selectedUserId == nil || viewModel.isSubmitting)
            }

            // Current shares list
            if viewModel.isLoadingShares {
                ProgressView()
                    .frame(maxWidth: .infinity, alignment: .center)
            } else {
                ForEach(viewModel.shares) { share in
                    ShareRowView(share: share) {
                        Task { await viewModel.removeShare(userId: share.user_id) }
                    }
                }
            }
        } header: {
            Text("Freigabe für Benutzer")
        } footer: {
            if !viewModel.shares.isEmpty {
                Text("\(viewModel.shares.count) aktive Freigabe(n)")
            }
        }
    }

    // MARK: - Public Link Section

    @ViewBuilder
    private var publicLinkSection: some View {
        Section("Öffentlicher Link") {
            if let url = publicLinkURL {
                // Link URL display
                Text(url)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
                    .textSelection(.enabled)

                // Expiry info
                if let expiresAt = viewModel.publicLink?.expires_at {
                    Label("Gültig bis \(formatDate(expiresAt))", systemImage: "calendar.badge.clock")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    Label("Unbegrenzt gültig", systemImage: "infinity")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                // Copy button
                Button {
                    UIPasteboard.general.string = url
                    copiedToClipboard = true
                    Task {
                        try? await Task.sleep(for: .seconds(2))
                        copiedToClipboard = false
                    }
                } label: {
                    Label(
                        copiedToClipboard ? "Kopiert!" : "Link kopieren",
                        systemImage: copiedToClipboard ? "checkmark" : "doc.on.doc"
                    )
                }
                .foregroundStyle(copiedToClipboard ? .green : .accentColor)

                // Delete link button
                Button(role: .destructive) {
                    Task { await viewModel.deletePublicLink() }
                } label: {
                    Label("Link löschen", systemImage: "trash")
                }
            } else {
                // Expiry picker
                Picker("Gültigkeit", selection: $linkExpiry) {
                    Text("Unbegrenzt").tag(Optional<String>.none)
                    Text("7 Tage").tag(Optional("7d"))
                    Text("30 Tage").tag(Optional("30d"))
                    Text("90 Tage").tag(Optional("90d"))
                }
                .pickerStyle(.segmented)

                Button {
                    Task { await viewModel.createPublicLink(expiresIn: linkExpiry) }
                } label: {
                    if viewModel.isSubmitting {
                        ProgressView()
                            .frame(maxWidth: .infinity, alignment: .center)
                    } else {
                        Label("Öffentlichen Link erstellen", systemImage: "link.badge.plus")
                            .frame(maxWidth: .infinity, alignment: .center)
                    }
                }
                .disabled(viewModel.isSubmitting)
            }
        }
    }

    // MARK: - Helpers

    private func formatDate(_ dateString: String) -> String {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = iso.date(from: dateString) ?? ISO8601DateFormatter().date(from: dateString)
        guard let date else { return dateString }
        let df = DateFormatter()
        df.dateStyle = .medium
        df.locale = Locale(identifier: "de_DE")
        return df.string(from: date)
    }
}

// MARK: - Share Row

private struct ShareRowView: View {
    let share: AlbumShareWithUser
    let onDelete: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(share.user_name)
                    .font(.subheadline)
                    .fontWeight(.medium)
                Text(share.user_email)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer()

            // Access level tag
            let isRead = share.access_level == "read"
            Text(isRead ? "Nur lesen" : "Bearbeiten")
                .font(.caption)
                .fontWeight(.medium)
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(isRead ? Color.blue.opacity(0.12) : Color.green.opacity(0.12))
                .foregroundStyle(isRead ? Color.blue : Color.green)
                .clipShape(Capsule())

            // Remove button
            Button(action: onDelete) {
                Image(systemName: "xmark.circle.fill")
                    .foregroundStyle(.secondary)
                    .imageScale(.large)
            }
            .buttonStyle(.plain)
        }
        .padding(.vertical, 2)
    }
}

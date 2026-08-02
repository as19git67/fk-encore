import SwiftUI

/// Album sharing UI — the iOS counterpart of the web share dialog: invite
/// internal users with read / write / write_share access and manage the public
/// link. Reachable from the album detail view and from the active trip
/// (issue #918).
struct AlbumShareView: View {
    let albumId: Int
    /// Album title, shown as the sheet subtitle when the caller knows it.
    let albumName: String?

    @State private var viewModel: AlbumShareViewModel
    @State private var selectedUserId: Int? = nil
    @State private var selectedAccessLevel: AlbumAccessLevel = .read
    @State private var linkExpiry: String? = nil
    @State private var showErrorAlert = false
    @State private var copiedToClipboard = false
    /// Shown when "Fertig" is tapped while a user is picked but not yet added —
    /// otherwise the selection silently disappears with no share created.
    @State private var showPendingSelectionWarning = false
    @Environment(\.dismiss) private var dismiss
    @Environment(AuthManager.self) private var authManager
    @AppStorage(APIClient.serverURLKey) private var serverURL: String = "http://localhost:4000"

    /// - Parameters:
    ///   - albumId: album to share.
    ///   - albumName: optional title for the sheet header.
    ///   - accessLevel: the caller's own access level when already known
    ///     (`owner`, `write_share`, …). When omitted it is resolved from the
    ///     album list, which is what the trip view relies on.
    init(albumId: Int, albumName: String? = nil, accessLevel: String? = nil) {
        self.albumId = albumId
        self.albumName = albumName
        _viewModel = State(initialValue: AlbumShareViewModel(albumId: albumId, accessLevel: accessLevel))
    }

    var publicLinkURL: String? {
        guard let link = viewModel.publicLink else { return nil }
        return "\(serverURL)/albums/public/\(link.token)"
    }

    var body: some View {
        NavigationStack {
            List {
                if let albumName, !albumName.isEmpty {
                    Section {
                        Label(albumName, systemImage: "rectangle.stack")
                            .font(.subheadline)
                    }
                }
                addShareSection
                existingSharesSection
                publicLinkSection
            }
            .navigationTitle("Freigabe")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Fertig") {
                        if selectedUserId != nil {
                            // A pending, not-yet-added selection would otherwise
                            // silently vanish with no share created.
                            showPendingSelectionWarning = true
                        } else {
                            dismiss()
                        }
                    }
                }
            }
            .confirmationDialog(
                "Ausgewählter Benutzer wurde nicht hinzugefügt",
                isPresented: $showPendingSelectionWarning,
                titleVisibility: .visible
            ) {
                Button("Ohne Freigabe schliessen", role: .destructive) { dismiss() }
                Button("Zurück", role: .cancel) {}
            } message: {
                Text("Du hast einen Benutzer ausgewählt, aber noch nicht auf „Hinzufügen“ getippt. Ohne das bleibt die Freigabe unwirksam.")
            }
            .task {
                // The caller's user id decides which delegate-created shares may
                // be revoked, so it is wired in before the first load.
                viewModel.setCurrentUserId(authManager.currentUser?.id)
                await viewModel.load()
            }
            .alert("Fehler", isPresented: $showErrorAlert) {
                Button("OK", role: .cancel) { viewModel.errorMessage = nil }
            } message: {
                Text(viewModel.errorMessage ?? "")
            }
            .onChange(of: viewModel.errorMessage) { _, newValue in
                if newValue != nil { showErrorAlert = true }
            }
            .onChange(of: viewModel.isOwner) { _, _ in
                // A delegate must not keep a preselected level they cannot grant.
                if !viewModel.grantableAccessLevels.contains(selectedAccessLevel) {
                    selectedAccessLevel = .read
                }
            }
        }
    }

    // MARK: - Add Share Section

    private var canAddShare: Bool {
        selectedUserId != nil && !viewModel.isSubmitting
    }

    @ViewBuilder
    private var addShareSection: some View {
        Section {
            if viewModel.isLoadingUsers {
                ProgressView("Benutzer laden…")
                    .frame(maxWidth: .infinity, alignment: .center)
            } else if viewModel.usersLoadFailed {
                Label("Benutzerliste nicht verfügbar", systemImage: "exclamationmark.triangle")
                    .foregroundStyle(.secondary)
                    .font(.subheadline)
            } else if viewModel.availableUsers.isEmpty {
                Text("Keine weiteren Benutzer verfügbar")
                    .foregroundStyle(.secondary)
                    .font(.subheadline)
            } else {
                Picker("Benutzer", selection: $selectedUserId) {
                    Text("Benutzer wählen…").tag(Optional<Int>.none)
                    ForEach(viewModel.availableUsers) { user in
                        VStack(alignment: .leading) {
                            Text(user.name)
                            Text(user.email).font(.caption).foregroundStyle(.secondary)
                        }
                        .tag(Optional(user.id))
                    }
                }

                Picker("Zugriff", selection: $selectedAccessLevel) {
                    ForEach(viewModel.grantableAccessLevels) { level in
                        Text(level.label).tag(level)
                    }
                }
                .pickerStyle(.menu)

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
                        // Explicit colour (not just `.disabled`'s system dimming)
                        // so "no user picked yet" reads unambiguously as
                        // disabled rather than a slightly muted active button.
                        Label("Hinzufügen", systemImage: "person.badge.plus")
                            .frame(maxWidth: .infinity, alignment: .center)
                            .foregroundStyle(canAddShare ? Color.accentColor : Color.secondary)
                    }
                }
                .disabled(!canAddShare)
            }
        } header: {
            Text("Neue Freigabe")
        } footer: {
            if !viewModel.isOwner {
                Text("Als Bearbeiten + Teilen kannst du nur „Nur lesen“ und „Bearbeiten“ vergeben.")
            }
        }
    }

    // MARK: - Existing Shares Section

    @ViewBuilder
    private var existingSharesSection: some View {
        Section {
            if viewModel.isLoadingShares {
                ProgressView()
                    .frame(maxWidth: .infinity, alignment: .center)
            } else if viewModel.shares.isEmpty {
                Text("Noch keine Freigaben")
                    .foregroundStyle(.secondary)
                    .font(.subheadline)
            } else {
                ForEach(viewModel.shares) { share in
                    ShareRowView(share: share, canDelete: viewModel.canRemove(share)) {
                        Task { await viewModel.removeShare(userId: share.user_id) }
                    }
                }
            }
        } header: {
            Text("Freigaben")
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

                // Share the link through the system share sheet
                ShareLink(item: url) {
                    Label("Link teilen", systemImage: "square.and.arrow.up")
                }

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
    /// False when the caller may not revoke this share (delegates can only
    /// remove invitations they created themselves).
    let canDelete: Bool
    let onDelete: () -> Void

    private var level: AlbumAccessLevel {
        AlbumAccessLevel(rawValue: share.access_level) ?? .read
    }

    private var tint: Color {
        switch level {
        case .read:       return .blue
        case .write:      return .green
        case .writeShare: return .orange
        }
    }

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
            Text(level.shortLabel)
                .font(.caption)
                .fontWeight(.medium)
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(tint.opacity(0.12))
                .foregroundStyle(tint)
                .clipShape(Capsule())

            // Remove button
            if canDelete {
                Button(action: onDelete) {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.secondary)
                        .imageScale(.large)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.vertical, 2)
    }
}

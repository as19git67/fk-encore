import SwiftUI

/// The near-duplicate groups of one album, and the comparison over them.
///
/// The standalone „Gruppen-Review" walks every group the user owns. Inside an
/// album the question is narrower and far more useful: of *these* photos,
/// which near-duplicates are still undecided. The web has had this since
/// `AlbumDetailView.vue`; iOS had only the global queue (#1085 §2b).
///
/// `GET /photos/groups` is not album-aware and does not need to be — the
/// intersection is `AlbumGroupReview.scoped`, the same client-side trim the
/// web does.
struct AlbumGroupReviewSheet: View {
    /// Every photo in the album. Which of them a group may still be scoped to
    /// is decided here, from the album's own curation plus whatever has been
    /// voted on in this session.
    let photos: [PhotoWithCuration]
    let curationOverrides: [Int: CurationStatus]
    /// Called with the ids that were hidden, so the album can update its grid
    /// without a reload.
    var onHidden: ([Int]) -> Void

    @Environment(\.dismiss) private var dismiss

    @State private var groups: [AlbumGroupReview.Group] = []
    @State private var isLoading = true
    @State private var errorMessage: String?
    @State private var comparing: AlbumGroupReview.Group?
    @State private var toastMessage: ToastMessage?

    var body: some View {
        NavigationStack {
            Group {
                if isLoading {
                    ProgressView("Gruppen laden…")
                } else if let errorMessage {
                    ContentUnavailableView(
                        "Gruppen nicht geladen",
                        systemImage: "exclamationmark.triangle",
                        description: Text(errorMessage)
                    )
                } else if groups.isEmpty {
                    ContentUnavailableView(
                        "Keine Serien",
                        systemImage: "square.stack.3d.up.slash",
                        description: Text(
                            "In diesem Album sind keine zwei Fotos ähnlich genug, um verglichen zu werden."
                        )
                    )
                } else {
                    list
                }
            }
            // Same name as the menu entry that opens this, and as the
            // global queue it is a scoped version of — "Ähnliche Fotos"
            // used to name this screen while everything pointing at it
            // said "Gruppen-Review", which read as two features.
            .navigationTitle("Gruppen-Review")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Fertig") { dismiss() }
                }
            }
            .toast($toastMessage)
            .task { await load() }
            .fullScreenCover(item: $comparing) { group in
                PhotoCompareView(
                    photos: AlbumGroupReview.comparablePhotos(for: group, from: photos)
                ) { keep in
                    Task { await commit(group: group, keep: keep) }
                }
            }
        }
    }

    private var list: some View {
        List {
            Section {
                ForEach(groups) { group in
                    Button {
                        comparing = group
                    } label: {
                        row(group)
                    }
                }
            } footer: {
                Text("Verglichen wird immer paarweise; ausgeblendet wird erst, wenn die Auswahl am Ende bestätigt ist.")
            }
        }
    }

    private func row(_ group: AlbumGroupReview.Group) -> some View {
        HStack(spacing: 12) {
            if let coverId = group.cover_photo_id,
               let cover = photos.first(where: { $0.id == coverId }) {
                PhotoThumbnailView(
                    filename: cover.filename,
                    autoCrop: cover.auto_crop,
                    photoId: cover.id
                )
                .frame(width: 56, height: 56)
                .clipShape(RoundedRectangle(cornerRadius: 8))
            }
            VStack(alignment: .leading, spacing: 2) {
                Text("\(group.member_count) ähnliche Fotos")
                if group.reviewed_at != nil {
                    Text("Schon einmal entschieden")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
            Image(systemName: "chevron.right")
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
    }

    /// `pick-photos` answers `{ success }` and nothing else — not the app-wide
    /// `SuccessResponse`, which also expects a message.
    private struct PickResponse: Decodable { let success: Bool }

    // MARK: - Data

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let response: AlbumGroupReview.ListResponse = try await APIClient.shared.get(
                "/photos/groups"
            )
            groups = AlbumGroupReview.scoped(
                groups: response.groups,
                toVisiblePhotoIds: AlbumGroupReview.visibleIds(
                    in: photos, overrides: curationOverrides
                )
            )
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// The one write in this flow: everything before it was local.
    private func commit(group: AlbumGroupReview.Group, keep: [Int]) async {
        guard !keep.isEmpty else { return }
        do {
            _ = try await APIClient.shared.post(
                "/photos/groups/\(group.id)/pick-photos",
                body: AlbumGroupReview.PickRequest(photoIds: keep)
            ) as PickResponse
            let hidden = group.photo_ids.filter { !keep.contains($0) }
            onHidden(hidden)
            groups.removeAll { $0.id == group.id }
            toastMessage = ToastMessage(
                text: hidden.isEmpty
                    ? "Alle Fotos behalten"
                    : "\(hidden.count) ausgeblendet",
                style: .success
            )
        } catch {
            toastMessage = ToastMessage(text: error.localizedDescription, style: .error)
        }
    }
}

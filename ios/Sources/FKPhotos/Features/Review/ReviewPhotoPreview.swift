import SwiftUI

/// Full-size look at the members of one review group.
///
/// This exists because tapping a thumbnail on the review card used to *decide*
/// the group („keep only this one"). A tap is what people reach for to judge
/// whether a photo is sharp enough to survive — gesture and consequence
/// pointed in opposite directions, and a mis-tap hid the rest of the group
/// behind an undo most users never noticed. Tapping opens this preview;
/// keeping a single photo is an explicit, labelled button that says what it
/// costs.
///
/// It used to be a viewer of its own — its own pager, its own zoom, its own
/// loading — which meant everything the real viewer gained (crop rendering,
/// the info panel, delete, download, the location map) stopped at its edge.
/// It is now `PhotoFullscreenView` with a footer passed in (#1085 §4): the
/// review-specific part is the footer and nothing else.
///
/// ## Two modes
///
/// - **Decide** (opened from the review card): the footer offers „Nur dieses
///   Foto behalten", which resolves the group immediately.
/// - **Edit a pending selection** (opened from `ReviewSelectionSheet`): the
///   footer carries the same thumbs up/down as the list behind it, bound to
///   the sheet's keep set. Full size is where you can actually tell whether a
///   photo is sharp enough, so that is where changing your mind has to be
///   possible — without going back to the list first.
struct ReviewPhotoPreview: View {
    let group: ReviewQueueGroup
    /// nil when the user lacks `photos.delete` — the preview then only shows.
    let onPickOne: ((Int) -> Void)?
    /// Bound in edit mode; the toggles write straight through to the sheet, so
    /// closing the preview needs no separate „apply" step.
    private let keep: Binding<Set<Int>>?
    private let startPhotoId: Int

    /// The group's photos as the viewer wants them. The review queue carries
    /// a trimmed row — id, filename, score — and the viewer shows the full
    /// metadata, so the rows are fetched once here.
    @State private var rows: [PhotoWithCuration] = []
    @State private var index = 0
    @State private var isLoading = true
    @Environment(\.dismiss) private var dismiss

    init(group: ReviewQueueGroup, startPhotoId: Int, onPickOne: ((Int) -> Void)?) {
        self.group = group
        self.onPickOne = onPickOne
        self.keep = nil
        self.startPhotoId = startPhotoId
    }

    /// Edit mode — see the type comment.
    init(group: ReviewQueueGroup, startPhotoId: Int, keep: Binding<Set<Int>>) {
        self.group = group
        self.onPickOne = nil
        self.keep = keep
        self.startPhotoId = startPhotoId
    }

    private var photos: [ReviewQueuePhoto] { group.orderedPhotos }

    private var queuePhotoById: [Int: ReviewQueuePhoto] {
        Dictionary(uniqueKeysWithValues: photos.map { ($0.id, $0) })
    }

    var body: some View {
        NavigationStack {
            Group {
                if !rows.isEmpty {
                    PhotoFullscreenView(
                        photos: rows,
                        currentIndex: $index,
                        contextFooter: { photo in AnyView(footer(for: photo)) }
                    )
                } else if isLoading {
                    ProgressView("Foto laden…")
                } else {
                    ContentUnavailableView(
                        "Fotos nicht verfügbar",
                        systemImage: "photo",
                        description: Text("Die Fotos dieser Gruppe konnten nicht geladen werden.")
                    )
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Fertig") { dismiss() }
                        }
                    }
                }
            }
            .task { await load() }
        }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        let ids = photos.map(\.id)
        guard !ids.isEmpty else { return }
        do {
            // The group's own order, not the batch endpoint's: the AI's pick
            // leads the card, and the preview has to agree with it.
            rows = try await PhotoFetch.byIds(ids)
            index = rows.firstIndex { $0.id == startPhotoId } ?? 0
        } catch {
            rows = []
        }
    }

    // MARK: - Footer

    /// Everything the review knows and the viewer does not: whether this is
    /// the AI's pick, what it scored, how the album's other members voted, and
    /// what deciding would cost.
    @ViewBuilder
    private func footer(for photo: PhotoWithCuration) -> some View {
        let queuePhoto = queuePhotoById[photo.id]
        VStack(spacing: 10) {
            HStack(spacing: 10) {
                if group.pickedPhotoIds.contains(photo.id) {
                    Label("KI-Vorschlag", systemImage: "sparkles")
                        .font(.caption).bold()
                        .foregroundStyle(.tint)
                }
                if let percent = queuePhoto?.qualityPercent {
                    Label("\(percent) %", systemImage: "wand.and.stars")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                }
                if let peer = queuePhoto?.peer_curation, peer.hasSignal {
                    if peer.favorite > 0 {
                        Label("\(peer.favorite)", systemImage: "heart.fill")
                            .font(.caption)
                            .foregroundStyle(.pink)
                    }
                    if peer.hidden > 0 {
                        Label("\(peer.hidden)", systemImage: "eye.slash.fill")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer()
            }

            if let keep {
                keepControls(for: photo.id, keep: keep)
            } else if let onPickOne {
                Button {
                    // Dismiss first: the card underneath advances immediately,
                    // so leaving the preview open would show a photo that no
                    // longer belongs to the group on screen.
                    dismiss()
                    onPickOne(photo.id)
                } label: {
                    VStack(spacing: 2) {
                        Label("Nur dieses Foto behalten", systemImage: "checkmark.circle.fill")
                            .font(.subheadline).bold()
                        if group.member_count > 1 {
                            Text(group.member_count == 2
                                 ? "Das andere Foto wird ausgeblendet."
                                 : "Die anderen \(group.member_count - 1) Fotos werden ausgeblendet.")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 10)
                    .background(Color.accentColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 10)
        .padding(.bottom, 6)
        .background(.bar)
    }

    // MARK: - Edit mode

    @ViewBuilder
    private func keepControls(for photoId: Int, keep: Binding<Set<Int>>) -> some View {
        let isKept = keep.wrappedValue.contains(photoId)
        VStack(spacing: 6) {
            HStack(spacing: 10) {
                thumbButton(
                    systemImage: isKept ? "hand.thumbsup.fill" : "hand.thumbsup",
                    title: "Behalten",
                    tint: .accentColor,
                    active: isKept
                ) {
                    keep.wrappedValue.insert(photoId)
                }

                thumbButton(
                    systemImage: isKept ? "hand.thumbsdown" : "hand.thumbsdown.fill",
                    title: "Ausblenden",
                    tint: .secondary,
                    active: !isKept
                ) {
                    keep.wrappedValue.remove(photoId)
                }
            }

            // The commit button lives in the sheet, so an empty selection can
            // only be noticed here — say so rather than letting the user find
            // out after closing the preview.
            Text(summary(for: keep.wrappedValue))
                .font(.caption2)
                .foregroundStyle(keep.wrappedValue.isEmpty ? Color.orange : Color.secondary)
        }
    }

    private func summary(for keep: Set<Int>) -> String {
        guard !keep.isEmpty else { return "Mindestens ein Foto muss behalten werden." }
        return "\(keep.count) von \(photos.count) behalten"
    }

    private func thumbButton(
        systemImage: String,
        title: String,
        tint: Color,
        active: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Label(title, systemImage: systemImage)
                .font(.subheadline)
                .foregroundStyle(active ? tint : Color.secondary.opacity(0.6))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 10)
                .background(
                    active ? tint.opacity(0.14) : Color.clear,
                    in: RoundedRectangle(cornerRadius: 12)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 12)
                        .strokeBorder(active ? tint.opacity(0.35) : Color.clear)
                )
        }
        .buttonStyle(.plain)
        .accessibilityLabel(title)
    }
}

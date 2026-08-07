import SwiftUI

/// Full-size look at the members of one review group, pageable and zoomable.
///
/// This exists because tapping a thumbnail on the review card used to *decide*
/// the group ("keep only this one"). A tap is what people reach for to judge
/// whether a photo is sharp enough to survive — gesture and consequence pointed
/// in opposite directions, and a mis-tap hid the rest of the group behind an
/// undo most users never noticed. Tapping now opens this preview; keeping a
/// single photo became an explicit, labelled button that says what it costs.
///
/// The image is the full file (`ThumbnailLoader` downloads `/photos/file/...`),
/// so pinch-zoom actually resolves the detail the decision hangs on.
///
/// ## Two modes
///
/// - **Decide** (opened from the review card): the footer offers "Nur dieses
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
    /// closing the preview needs no separate "apply" step.
    private let keep: Binding<Set<Int>>?

    @State private var selection: Int
    @Environment(\.dismiss) private var dismiss

    init(group: ReviewQueueGroup, startPhotoId: Int, onPickOne: ((Int) -> Void)?) {
        self.group = group
        self.onPickOne = onPickOne
        self.keep = nil
        _selection = State(initialValue: startPhotoId)
    }

    /// Edit mode — see the type comment.
    init(group: ReviewQueueGroup, startPhotoId: Int, keep: Binding<Set<Int>>) {
        self.group = group
        self.onPickOne = nil
        self.keep = keep
        _selection = State(initialValue: startPhotoId)
    }

    private var photos: [ReviewQueuePhoto] { group.orderedPhotos }

    private var currentPhoto: ReviewQueuePhoto? {
        photos.first { $0.id == selection }
    }

    private var currentPosition: Int {
        (photos.firstIndex { $0.id == selection } ?? 0) + 1
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                TabView(selection: $selection) {
                    ForEach(photos) { photo in
                        ReviewPreviewPage(photo: photo, isPicked: group.pickedPhotoIds.contains(photo.id))
                            .tag(photo.id)
                    }
                }
                .tabViewStyle(.page(indexDisplayMode: photos.count > 1 ? .automatic : .never))
                .ignoresSafeArea(edges: .bottom)

                if let photo = currentPhoto {
                    footer(for: photo)
                }
            }
            .background(Color(.systemBackground))
            .navigationTitle("\(currentPosition) von \(photos.count)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Fertig") { dismiss() }
                }
            }
        }
    }

    // MARK: - Footer

    @ViewBuilder
    private func footer(for photo: ReviewQueuePhoto) -> some View {
        VStack(spacing: 10) {
            HStack(spacing: 10) {
                if group.pickedPhotoIds.contains(photo.id) {
                    Label("KI-Vorschlag", systemImage: "sparkles")
                        .font(.caption).bold()
                        .foregroundStyle(.tint)
                }
                if let percent = photo.qualityPercent {
                    Label("\(percent) %", systemImage: "wand.and.stars")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                }
                if let peer = photo.peer_curation, peer.hasSignal {
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
                keepControls(for: photo, keep: keep)
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
    private func keepControls(for photo: ReviewQueuePhoto, keep: Binding<Set<Int>>) -> some View {
        let isKept = keep.wrappedValue.contains(photo.id)
        VStack(spacing: 6) {
            HStack(spacing: 10) {
                thumbButton(
                    systemImage: isKept ? "hand.thumbsup.fill" : "hand.thumbsup",
                    title: "Behalten",
                    tint: .accentColor,
                    active: isKept
                ) {
                    keep.wrappedValue.insert(photo.id)
                }

                thumbButton(
                    systemImage: isKept ? "hand.thumbsdown" : "hand.thumbsdown.fill",
                    title: "Ausblenden",
                    tint: .secondary,
                    active: !isKept
                ) {
                    keep.wrappedValue.remove(photo.id)
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

/// One zoomable page of the preview. Mirrors `PhotoPageView`'s loading so the
/// review reuses the same cache entry as the rest of the app.
private struct ReviewPreviewPage: View {
    let photo: ReviewQueuePhoto
    let isPicked: Bool

    @State private var loader: ThumbnailLoader

    init(photo: ReviewQueuePhoto, isPicked: Bool) {
        self.photo = photo
        self.isPicked = isPicked
        _loader = State(initialValue: ThumbnailLoader(filename: photo.filename))
    }

    var body: some View {
        GeometryReader { geo in
            Group {
                if let image = loader.image {
                    ZoomableImageView(image: image)
                } else if loader.hasError {
                    Image(systemName: "exclamationmark.triangle")
                        .font(.largeTitle)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    ProgressView()
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .frame(width: geo.size.width, height: geo.size.height)
        }
        .task { await loader.load() }
    }
}

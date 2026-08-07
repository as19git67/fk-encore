import SwiftUI

/// Manual override of the AI's pick for one group — the mobile counterpart to
/// the confirmation phase of the web's compare view
/// (`frontend/src/components/PhotoCompareView.vue`).
///
/// Until now iOS could only accept the AI's suggestion wholesale, keep
/// everything, or keep exactly *one* photo. There was no way to say "keep
/// these two, drop that one", even though `POST /photos/groups/:id/pick-photos`
/// has always taken an arbitrary keep set — the capability existed, the UI
/// didn't expose it.
///
/// Like the web, every toggle here is **local**: nothing is sent until the
/// user commits, so the group can be rearranged freely and abandoned without
/// side effects.
struct ReviewSelectionSheet: View {
    let group: ReviewQueueGroup
    /// Receives the final keep set. Never called with an empty array — the
    /// commit button is disabled in that state, because `pick-photos` requires
    /// at least one keeper and "hide everything" is not a decision the review
    /// flow should make silently.
    let onCommit: ([Int]) -> Void

    @State private var keep: Set<Int>
    @State private var previewPhotoId: Int?
    @Environment(\.dismiss) private var dismiss

    init(group: ReviewQueueGroup, onCommit: @escaping ([Int]) -> Void) {
        self.group = group
        self.onCommit = onCommit
        // Pre-filled from the AI's suggestion, exactly like the web pre-fills
        // from the compare result. A group without a suggestion starts with
        // everything kept, so the destructive direction always needs a
        // deliberate tap rather than being the default.
        let picked = Set(group.pickedPhotoIds)
        _keep = State(initialValue: picked.isEmpty ? Set(group.photos.map(\.id)) : picked)
    }

    private var photos: [ReviewQueuePhoto] { group.orderedPhotos }
    private var hideCount: Int { photos.count - keep.count }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(photos) { photo in
                        row(for: photo)
                    }
                } footer: {
                    Text(footerText)
                }
            }
            .navigationTitle("Auswahl anpassen")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Abbrechen") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Übernehmen") {
                        let ids = photos.map(\.id).filter { keep.contains($0) }
                        dismiss()
                        onCommit(ids)
                    }
                    .bold()
                    .disabled(keep.isEmpty)
                }
            }
            .safeAreaInset(edge: .bottom) {
                if !group.pickedPhotoIds.isEmpty && keep != Set(group.pickedPhotoIds) {
                    Button {
                        keep = Set(group.pickedPhotoIds)
                    } label: {
                        Label("Auf KI-Vorschlag zurücksetzen", systemImage: "arrow.uturn.backward")
                            .font(.footnote)
                    }
                    .padding(.vertical, 8)
                    .frame(maxWidth: .infinity)
                    .background(.bar)
                }
            }
            .fullScreenCover(item: previewTargetBinding) { target in
                // Judging a photo at thumbnail size is exactly what made the
                // old tap-to-decide interaction wrong, so the override sheet
                // offers the same full-size look — read-only here, since the
                // decision is the toggle next to it.
                ReviewPhotoPreview(group: group, startPhotoId: target.id, onPickOne: nil)
            }
        }
    }

    private var previewTargetBinding: Binding<PreviewTarget?> {
        Binding(
            get: { previewPhotoId.map(PreviewTarget.init(id:)) },
            set: { previewPhotoId = $0?.id }
        )
    }

    private struct PreviewTarget: Identifiable {
        let id: Int
    }

    private var footerText: String {
        if keep.isEmpty {
            return "Mindestens ein Foto muss behalten werden."
        }
        let kept = keep.count == 1 ? "1 Foto behalten" : "\(keep.count) Fotos behalten"
        if hideCount == 0 {
            return "\(kept), nichts wird ausgeblendet."
        }
        return hideCount == 1
            ? "\(kept), 1 Foto wird ausgeblendet."
            : "\(kept), \(hideCount) Fotos werden ausgeblendet."
    }

    // MARK: - Row

    private func row(for photo: ReviewQueuePhoto) -> some View {
        let isKept = keep.contains(photo.id)
        return HStack(spacing: 12) {
            Button {
                previewPhotoId = photo.id
            } label: {
                PhotoThumbnailView(filename: photo.filename)
                    .frame(width: 64, height: 64)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .overlay(alignment: .topLeading) {
                        if group.pickedPhotoIds.contains(photo.id) {
                            Label("KI", systemImage: "sparkles")
                                .font(.system(size: 8, weight: .bold))
                                .padding(.horizontal, 4)
                                .padding(.vertical, 2)
                                .background(.ultraThinMaterial, in: Capsule())
                                .padding(3)
                        }
                    }
                    .opacity(isKept ? 1 : 0.45)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Foto groß ansehen")

            VStack(alignment: .leading, spacing: 3) {
                if let percent = photo.qualityPercent {
                    Text("Qualität \(percent) %")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                }
                if let peer = photo.peer_curation, peer.hasSignal {
                    HStack(spacing: 8) {
                        if peer.favorite > 0 {
                            Label("\(peer.favorite)", systemImage: "heart.fill")
                                .font(.caption2)
                                .foregroundStyle(.pink)
                        }
                        if peer.hidden > 0 {
                            Label("\(peer.hidden)", systemImage: "eye.slash.fill")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                Text(isKept ? "Behalten" : "Ausblenden")
                    .font(.caption2)
                    .foregroundStyle(isKept ? Color.accentColor : Color.secondary)
            }

            Spacer()

            // Thumbs up / down rather than a checkbox, mirroring the web's
            // confirmation cards — the two directions are equally reachable,
            // so "hide this" is never a side effect of a mis-tap.
            HStack(spacing: 6) {
                toggleButton(
                    systemImage: isKept ? "hand.thumbsup.fill" : "hand.thumbsup",
                    tint: .accentColor,
                    active: isKept
                ) { keep.insert(photo.id) }

                toggleButton(
                    systemImage: isKept ? "hand.thumbsdown" : "hand.thumbsdown.fill",
                    tint: .secondary,
                    active: !isKept
                ) { keep.remove(photo.id) }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(isKept ? "Foto wird behalten" : "Foto wird ausgeblendet")
        .accessibilityAction(named: isKept ? "Ausblenden" : "Behalten") {
            if isKept { keep.remove(photo.id) } else { keep.insert(photo.id) }
        }
    }

    private func toggleButton(
        systemImage: String,
        tint: Color,
        active: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.title3)
                .foregroundStyle(active ? tint : Color.secondary.opacity(0.5))
                .frame(width: 40, height: 36)
                .background(
                    active ? tint.opacity(0.14) : Color.clear,
                    in: RoundedRectangle(cornerRadius: 9)
                )
        }
        .buttonStyle(.plain)
    }
}

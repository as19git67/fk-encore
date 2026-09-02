import SwiftUI

/// Swipe-based group review (issue #761) — the mobile counterpart to the web's
/// "Rapid Review" (`frontend/src/views/ReviewQueueView.vue`).
///
/// One card per similar-photo group. The AI's suggestion is highlighted, and
/// the whole group is resolved with a single flick:
///
/// - **→ rechts** accept the suggestion (keep the pick, hide the rest)
/// - **← links** keep everything, just mark the group reviewed
/// - **↑ hoch** favorite the pick *and* accept it in one go
/// - **Tippen** auf ein Foto: open it full-size to judge the detail
///
/// Every swipe has an equivalent button underneath — a gesture-only interface
/// would be unusable with VoiceOver or Switch Control.
///
/// Note that a tap deliberately does *not* decide anything. Keeping a single
/// photo lives behind the labelled button in `ReviewPhotoPreview` and the
/// tile's context menu, because a tap is how people ask to *look closer*, not
/// how they ask to hide four photos.
struct ReviewQueueView: View {
    @State private var viewModel = ReviewQueueViewModel()
    @State private var dragOffset: CGSize = .zero
    @State private var previewTarget: PreviewTarget?
    @State private var showSelectionSheet = false
    /// Side-by-side comparison of the two leading candidates (#1021).
    @State private var showCompare = false
    @Environment(AuthManager.self) private var authManager

    /// The photo the full-size preview opens on. A wrapper because
    /// `fullScreenCover(item:)` needs an `Identifiable`.
    private struct PreviewTarget: Identifiable {
        let id: Int
    }

    /// Hiding photos is what a decision ultimately does, so it is gated on the
    /// same permission the backend enforces on every one of these endpoints.
    private var canDecide: Bool { authManager.hasPermission("photos.delete") }

    var body: some View {
        VStack(spacing: 0) {
            header

            if viewModel.isLoading && viewModel.state.groups.isEmpty {
                Spacer()
                ProgressView("Lade Gruppen…")
                Spacer()
            } else if let group = viewModel.state.current {
                cardArea(for: group)
                if canDecide {
                    actionBar(for: group)
                } else {
                    readOnlyNotice
                }
            } else {
                Spacer()
                completionState
                Spacer()
            }
        }
        .navigationTitle("Gruppen-Review")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                confidenceMenu
            }
        }
        .toast($viewModel.toastMessage)
        .fullScreenCover(item: $previewTarget) { target in
            if let group = viewModel.state.current {
                ReviewPhotoPreview(
                    group: group,
                    startPhotoId: target.id,
                    onPickOne: pickHandler
                )
            }
        }
        .sheet(isPresented: $showSelectionSheet) {
            if let group = viewModel.state.current {
                ReviewSelectionSheet(group: group) { keepIds in
                    viewModel.pickPhotos(keepIds)
                }
            }
        }
        .fullScreenCover(isPresented: $showCompare) {
            // The two leading candidates: `orderedPhotos` puts the AI's picks
            // first, so these are the two the decision is actually between.
            if let group = viewModel.state.current,
               group.orderedPhotos.count >= 2 {
                PhotoCompareView(
                    first: group.orderedPhotos[0],
                    second: group.orderedPhotos[1],
                    // A flung-away photo is a decision about the group: keep
                    // everything else. `pick-photos` needs at least one
                    // keeper, so a group of one is left alone.
                    onDiscard: { discardedId in
                        let keep = group.photos.map(\.id).filter { $0 != discardedId }
                        guard !keep.isEmpty else { return }
                        viewModel.pickPhotos(keep)
                    }
                )
            }
        }
        .task {
            if viewModel.state.groups.isEmpty { await viewModel.load() }
        }
        // The buffered decision only reaches the server when the next one is
        // made — leaving the screen has to push it, or the last swipe is lost.
        // Some iOS versions also fire this when the preview covers the screen;
        // flushing there would quietly end the undo window while the user is
        // merely looking at a photo, so that case is skipped.
        .onDisappear {
            guard previewTarget == nil else { return }
            Task { await viewModel.flush() }
        }
    }

    // MARK: - Header

    private var header: some View {
        VStack(spacing: 6) {
            ProgressView(value: viewModel.state.progress)
                .tint(.accentColor)
            HStack {
                Text("\(viewModel.state.decidedCount) von \(max(viewModel.state.total, viewModel.state.decidedCount)) entschieden")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
                if viewModel.isCommitting {
                    ProgressView()
                        .controlSize(.mini)
                }
                Spacer()
                if viewModel.state.canUndo {
                    Button {
                        viewModel.undo()
                    } label: {
                        Label("Rückgängig", systemImage: "arrow.uturn.backward")
                            .font(.caption)
                    }
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.bar)
    }

    private var confidenceMenu: some View {
        Menu {
            Picker("Sicherheit", selection: $viewModel.confidenceFilter) {
                Text("Alle").tag(ReviewConfidence?.none)
                ForEach(ReviewConfidence.allCases) { level in
                    Label(level.label, systemImage: level.systemImage)
                        .tag(ReviewConfidence?.some(level))
                }
            }
        } label: {
            Image(systemName: "line.3.horizontal.decrease.circle")
                .symbolVariant(viewModel.confidenceFilter == nil ? .none : .fill)
        }
        .accessibilityLabel("Nach Sicherheit filtern")
    }

    // MARK: - Card

    /// Resolves the group to exactly one keeper. Nil without the permission,
    /// which also removes the corresponding controls from the UI.
    private var pickHandler: ((Int) -> Void)? {
        guard canDecide else { return nil }
        return { photoId in viewModel.pickOnly(photoId: photoId) }
    }

    private func cardArea(for group: ReviewQueueGroup) -> some View {
        ReviewGroupCard(
            group: group,
            onPreview: { photoId in previewTarget = PreviewTarget(id: photoId) },
            onPickOne: pickHandler
        )
        .offset(dragOffset)
        .rotationEffect(.degrees(Double(dragOffset.width) / 26))
        .overlay(alignment: .top) { swipeHint }
        .gesture(canDecide ? dragGesture : nil)
        .animation(.interactiveSpring, value: dragOffset)
        .padding(.horizontal, 16)
        .padding(.top, 12)
        .frame(maxHeight: .infinity)
    }

    /// The decision the current drag would trigger, so the card can label
    /// itself before the finger lifts.
    private var activeSwipe: ReviewSwipe? {
        ReviewSwipe.resolve(
            translationWidth: dragOffset.width,
            translationHeight: dragOffset.height
        )
    }

    @ViewBuilder
    private var swipeHint: some View {
        if let swipe = activeSwipe {
            Label(swipe.label, systemImage: swipe.systemImage)
                .font(.headline)
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .background(.ultraThinMaterial, in: Capsule())
                .foregroundStyle(swipe == .keepAll ? Color.secondary : Color.accentColor)
                .padding(.top, 12)
                .transition(.scale.combined(with: .opacity))
        }
    }

    private var dragGesture: some Gesture {
        DragGesture()
            .onChanged { dragOffset = $0.translation }
            .onEnded { value in
                guard let swipe = ReviewSwipe.resolve(
                    translationWidth: value.translation.width,
                    translationHeight: value.translation.height
                ) else {
                    dragOffset = .zero
                    return
                }
                flingAway(swipe)
            }
    }

    /// Sends the card off screen, then advances. Decoupling the two keeps the
    /// next group from popping in behind a card that is still animating out.
    private func flingAway(_ swipe: ReviewSwipe) {
        withAnimation(.easeOut(duration: 0.18)) {
            switch swipe {
            case .keepPick: dragOffset = CGSize(width: 700, height: 0)
            case .keepAll:  dragOffset = CGSize(width: -700, height: 0)
            case .favorite: dragOffset = CGSize(width: 0, height: -900)
            }
        }
        Task {
            try? await Task.sleep(for: .milliseconds(180))
            viewModel.apply(swipe)
            dragOffset = .zero
        }
    }

    // MARK: - Actions

    private func actionBar(for group: ReviewQueueGroup) -> some View {
        VStack(spacing: 10) {
            HStack(spacing: 12) {
                actionButton(.keepAll, tint: .secondary)
                actionButton(.favorite, tint: .pink)
                    .disabled(!group.hasAiPick)
                actionButton(.keepPick, tint: .accentColor)
                    .disabled(!group.hasAiPick)
            }
            // Overriding the AI needs its own, always-present entry point:
            // the swipes can only accept or keep-all, and the per-photo
            // controls live one level down in the preview.
            Button {
                showSelectionSheet = true
            } label: {
                Label("Auswahl anpassen …", systemImage: "slider.horizontal.3")
                    .font(.subheadline)
            }
            // Deciding between two near-identical shots needs them at the
            // same size, not one after the other. Only offered where there
            // are actually two to compare.
            if group.orderedPhotos.count >= 2 {
                Button {
                    showCompare = true
                } label: {
                    Label("Vergleichen …", systemImage: "rectangle.split.2x1")
                        .font(.subheadline)
                }
            }
            if group.hasPeerSignal {
                Button {
                    viewModel.acceptPeerConsensus()
                } label: {
                    Label("Konsens der anderen übernehmen", systemImage: "person.2.badge.gearshape")
                        .font(.subheadline)
                }
            }
            if !group.hasAiPick {
                Text("Kein KI-Vorschlag für diese Gruppe – lege über „Auswahl anpassen“ fest, was bleiben soll.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
    }

    private func actionButton(_ swipe: ReviewSwipe, tint: Color) -> some View {
        Button {
            flingAway(swipe)
        } label: {
            VStack(spacing: 4) {
                Image(systemName: swipe.systemImage)
                    .font(.title2)
                Text(swipe.label)
                    .font(.caption2)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10)
            .background(tint.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
        }
        .tint(tint)
        .buttonStyle(.plain)
        .foregroundStyle(tint)
        .accessibilityLabel(swipe.label)
        .accessibilityHint(swipe.explanation)
    }

    private var readOnlyNotice: some View {
        Label(
            "Zum Entscheiden fehlt dir die Berechtigung „Fotos löschen“.",
            systemImage: "lock"
        )
        .font(.footnote)
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.center)
        .padding(16)
    }

    // MARK: - Empty / done

    @ViewBuilder
    private var completionState: some View {
        if let errorMessage = viewModel.errorMessage, viewModel.state.groups.isEmpty {
            ContentUnavailableView {
                Label("Warteschlange nicht geladen", systemImage: "exclamationmark.triangle")
            } description: {
                Text(errorMessage)
            } actions: {
                Button("Erneut versuchen") { Task { await viewModel.load() } }
            }
        } else if viewModel.state.decidedCount > 0 {
            ContentUnavailableView {
                Label("Durch!", systemImage: "checkmark.circle")
            } description: {
                Text(summaryText)
            } actions: {
                Button("Weitere laden") { Task { await viewModel.load() } }
            }
        } else {
            ContentUnavailableView {
                Label("Nichts zu prüfen", systemImage: "checkmark.circle")
            } description: {
                Text(viewModel.confidenceFilter == nil
                     ? "Es gibt gerade keine ähnlichen Fotos, über die du entscheiden müsstest."
                     : "In dieser Sicherheitsstufe ist nichts offen.")
            }
        }
    }

    private var summaryText: String {
        let decided = viewModel.state.decidedCount
        let base = decided == 1 ? "1 Gruppe entschieden." : "\(decided) Gruppen entschieden."
        guard viewModel.failedCommits > 0 else { return base }
        let failed = viewModel.failedCommits
        return base + (failed == 1
            ? " 1 Entscheidung konnte nicht gespeichert werden und erscheint später erneut."
            : " \(failed) Entscheidungen konnten nicht gespeichert werden und erscheinen später erneut.")
    }
}

// MARK: - Card

/// One group as a card: every member as a thumbnail, the AI's pick framed and
/// labelled, peer votes and quality shown per photo so the decision can be made
/// without opening anything.
private struct ReviewGroupCard: View {
    let group: ReviewQueueGroup
    /// Opens the photo full-size. Always available — looking is never a
    /// decision, so this works without the decide permission too.
    let onPreview: (Int) -> Void
    /// nil when the user may not decide — the "keep only this" affordances
    /// then disappear.
    let onPickOne: ((Int) -> Void)?

    private var columns: [GridItem] {
        [GridItem(.adaptive(minimum: 120, maximum: 220), spacing: 8)]
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                if let confidence = group.confidence {
                    Label(confidence.label, systemImage: confidence.systemImage)
                        .font(.caption).bold()
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(.quaternary, in: Capsule())
                }
                Text(group.member_count == 1 ? "1 Foto" : "\(group.member_count) Fotos")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                if group.isDuplicateCandidate {
                    Label("Duplikat", systemImage: "doc.on.doc")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
            }

            ScrollView {
                LazyVGrid(columns: columns, spacing: 8) {
                    ForEach(group.orderedPhotos) { photo in
                        photoTile(photo)
                    }
                }
            }
            .scrollBounceBehavior(.basedOnSize)
        }
        .padding(14)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 18))
        .overlay(
            RoundedRectangle(cornerRadius: 18)
                .strokeBorder(.quaternary)
        )
    }

    private func photoTile(_ photo: ReviewQueuePhoto) -> some View {
        let isPicked = group.pickedPhotoIds.contains(photo.id)
        return VStack(spacing: 4) {
            PhotoThumbnailView(filename: photo.filename, photoId: photo.id)
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .overlay(
                    RoundedRectangle(cornerRadius: 10)
                        .strokeBorder(isPicked ? Color.accentColor : .clear, lineWidth: 3)
                )
                .overlay(alignment: .topLeading) {
                    if isPicked {
                        Label("KI", systemImage: "sparkles")
                            .font(.system(size: 9, weight: .bold))
                            .padding(.horizontal, 6)
                            .padding(.vertical, 3)
                            .background(.ultraThinMaterial, in: Capsule())
                            .padding(5)
                    }
                }
                .overlay(alignment: .bottomTrailing) { peerBadges(photo) }

            HStack(spacing: 4) {
                if let percent = photo.qualityPercent {
                    Text("\(percent) %")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                }
                if photo.curation == .favorite {
                    Image(systemName: "heart.fill")
                        .font(.caption2)
                        .foregroundStyle(.pink)
                }
            }
        }
        .contentShape(Rectangle())
        .onTapGesture { onPreview(photo.id) }
        .contextMenu {
            Button {
                onPreview(photo.id)
            } label: {
                Label("Groß ansehen", systemImage: "arrow.up.left.and.arrow.down.right")
            }
            if let onPickOne {
                Button {
                    onPickOne(photo.id)
                } label: {
                    Label("Nur dieses behalten", systemImage: "checkmark.circle")
                }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel(photo, isPicked: isPicked))
        .accessibilityHint("Öffnet das Foto in voller Größe")
        // VoiceOver has no context menu, so the decision needs its own action.
        .accessibilityAction(named: "Nur dieses behalten") {
            onPickOne?(photo.id)
        }
    }

    @ViewBuilder
    private func peerBadges(_ photo: ReviewQueuePhoto) -> some View {
        if let peer = photo.peer_curation, peer.hasSignal {
            HStack(spacing: 3) {
                if peer.favorite > 0 {
                    peerBadge(systemImage: "heart.fill", count: peer.favorite, tint: .pink)
                }
                if peer.hidden > 0 {
                    peerBadge(systemImage: "eye.slash.fill", count: peer.hidden, tint: .secondary)
                }
            }
            .padding(5)
        }
    }

    private func peerBadge(systemImage: String, count: Int, tint: Color) -> some View {
        HStack(spacing: 2) {
            Image(systemName: systemImage)
                .font(.system(size: 8, weight: .bold))
                .foregroundStyle(tint)
            Text("\(count)")
                .font(.system(size: 9, weight: .semibold))
        }
        .padding(.horizontal, 4)
        .padding(.vertical, 2)
        .background(.ultraThinMaterial, in: Capsule())
    }

    private func accessibilityLabel(_ photo: ReviewQueuePhoto, isPicked: Bool) -> String {
        var parts: [String] = []
        parts.append(isPicked ? "KI-Vorschlag" : "Foto")
        if let percent = photo.qualityPercent { parts.append("Qualität \(percent) Prozent") }
        if let peer = photo.peer_curation, peer.hasSignal {
            if peer.favorite > 0 { parts.append("\(peer.favorite) mal favorisiert") }
            if peer.hidden > 0 { parts.append("\(peer.hidden) mal ausgeblendet") }
        }
        return parts.joined(separator: ", ")
    }
}

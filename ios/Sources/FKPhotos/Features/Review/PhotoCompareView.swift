import SwiftUI
import UIKit

/// Comparing a group of near-duplicates, two at a time, until one keep set is
/// left — the web's `PhotoCompareView` (#1021 stage A, #1085 §2a).
///
/// Two shots of the same moment, side by side, so the sharper one is obvious.
/// The deciding move is the same one the web has: tap a face and **both**
/// photos zoom to it at the same on-screen size. Two independently-zoomed
/// faces cannot be compared; matched ones can. The geometry is in
/// `PhotoCompare`.
///
/// The two zooms are solved **together, here** — each needs the other photo's
/// dimensions, so a pane cannot work its own out alone without the two halves
/// disagreeing.
///
/// A photo can also be thrown off the screen to drop it (`CompareSwipe`),
/// which is the web's fling gesture — every direction discards except the one
/// pointing at the partner photo, and the quality breakdown
/// (`PhotoQualityDetails`) says *why* one photo scored higher than the other.
///
/// A verdict does **not** end the group. It settles one pair and the next pair
/// is chosen; only when the pairs run out does the keep set go up for
/// confirmation and reach the server, once. That loop is `CompareTournament`,
/// which holds no view and no network so its ordering can be tested.
struct PhotoCompareView: View {
    /// The whole group. Two of them are on screen at any moment; which two is
    /// the tournament's business.
    let photos: [ReviewQueuePhoto]
    /// Called with the photos to keep, once, when the user confirms. The
    /// caller commits — this view never talks to the server about a decision.
    var onCommit: ([Int]) -> Void

    @Environment(\.dismiss) private var dismiss

    @State private var tournament: CompareTournament
    /// Which photos the confirmation will keep. Seeded from the tournament's
    /// proposal and still the user's to change.
    @State private var keepIds: Set<Int> = []

    @State private var images: [Int: UIImage] = [:]
    @State private var faces: [Int: [PhotoCompare.Candidate]] = [:]
    /// Sharpness per photo, in the same order as that photo's faces. A `nil`
    /// entry is a face that could not be measured — which is not the same as
    /// one measured as blurry, so it gets no frame rather than a red one.
    @State private var sharpness: [Int: [Double?]] = [:]
    @State private var showPeaking = true
    /// What both photos are zoomed to. Nil is the plain fit.
    @State private var focus: Focus?
    /// The photo currently flying off the screen, and where to. Set for the
    /// length of the animation, which is also what keeps a second fling from
    /// starting while the first is still in the air.
    @State private var flung: Flung?
    /// Freshly fetched quality per photo id. The review queue's copy can
    /// predate the scan, and it carries no breakdown at all.
    @State private var quality: [Int: PhotoQualityDetails.Fresh] = [:]
    @State private var showQuality = false
    @State private var showGestureHelp = false
    /// The group as the fullscreen viewer wants it, for the final check on the
    /// confirmation screen. Fetched once, because the queue's row carries only
    /// id, filename and score.
    @State private var rows: [PhotoWithCuration] = []
    @State private var checkIndex = 0
    @State private var isChecking = false
    /// Whether the confirmation has been filled from the tournament's proposal
    /// already. See `seedKeepIds()`.
    @State private var didSeedKeep = false
    /// The panes' arrangement, mirrored out of the `GeometryReader` because the
    /// bottom bar is chrome and sits outside it — „linkes" and „oberes" are
    /// the same button in different orientations.
    @State private var orientationIsPortrait = true

    init(photos: [ReviewQueuePhoto], onCommit: @escaping ([Int]) -> Void) {
        self.photos = photos
        self.onCommit = onCommit
        // The AI's ratings are a starting position, not a verdict: they only
        // decide which pair is asked about first.
        let seeds = CompareTournament.seedScores(
            qualities: Dictionary(
                uniqueKeysWithValues: photos.map { ($0.id, $0.ai_quality_score) }
            )
        )
        _tournament = State(
            initialValue: CompareTournament(
                photoIds: photos.map(\.id),
                seedScores: seeds,
                // Portrait and landscape frames of the same motif are not
                // redundant with each other — the keep set thins each shape
                // on its own rather than the group as a whole.
                orientations: Dictionary(
                    uniqueKeysWithValues: photos.map { ($0.id, $0.orientation) }
                )
            )
        )
    }

    private struct Flung: Equatable {
        let id: Int
        let offset: CGSize
    }

    /// What the two sides line up on.
    private enum Focus: Equatable {
        /// The same person in both — the best case, and what a tap on a named
        /// face gives.
        case person(id: Int)
        /// A tapped face with no person attached. There is nothing to match
        /// across, so each side falls back to its own primary face.
        case primary

        /// The person to line both sides up on, if there is one.
        var personId: Int? {
            if case .person(let id) = self { return id }
            return nil
        }
    }

    private var photoById: [Int: ReviewQueuePhoto] {
        Dictionary(uniqueKeysWithValues: photos.map { ($0.id, $0) })
    }

    /// The pair on screen, or nil once the pairwise half is over.
    private var pair: (first: ReviewQueuePhoto, second: ReviewQueuePhoto)? {
        guard let current = tournament.current else { return nil }
        let byId = photoById
        guard let first = byId[current.low], let second = byId[current.high] else {
            return nil
        }
        return (first, second)
    }

    var body: some View {
        NavigationStack {
            Group {
                if let pair {
                    comparing(pair)
                } else {
                    confirmation
                }
            }
            .background(Color.black)
            .navigationTitle(pair == nil ? "Auswahl" : "Vergleich")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar { toolbarContent }
            // Keyed on the pair, so moving to the next one fetches it — and
            // the first pair is fetched by the same task on appear.
            .task(id: tournament.current) { await load() }
            // Pushed onto this screen's own NavigationStack rather than a
            // second `fullScreenCover` — this view is itself already reached
            // through one (from the review queue), and stacking a full-screen
            // cover on top of a full-screen cover is a known bad pairing:
            // the inner cover's content can end up presented before its
            // GeometryReader-driven layout ever gets a non-zero size, so the
            // toolbar appears but the photo never does. `PhotoFullscreenView`
            // is documented to support exactly this — pushed via
            // `navigationDestination` — which is also the plainer fix: no
            // second modal, no second NavigationStack to nest.
            .navigationDestination(isPresented: $isChecking) {
                PhotoFullscreenView(
                    photos: rows,
                    currentIndex: $checkIndex,
                    contextFooter: { photo in
                        AnyView(checkFooter(photoId: photo.id))
                    },
                    // The footer below already carries this photo's
                    // keep/hide state for *this review*, and the viewer's own
                    // thumbs-down would otherwise stand for something else
                    // entirely — the global curation status, written straight
                    // to the server. Pointing both at the review's keep set
                    // makes them one control shown twice: the thumbs-down
                    // fills in exactly when the footer says „Ausblenden", and
                    // either one flips the same pending decision.
                    hideDecision: .init(
                        isHidden: { !keepIds.contains($0.id) },
                        toggle: { toggleKeep($0.id) }
                    )
                )
            }
            .popover(isPresented: $showGestureHelp) {
                GestureHelp(isPortrait: orientationIsPortrait)
                    .presentationCompactAdaptation(.popover)
            }
            .sheet(isPresented: $showQuality) {
                if let pair {
                    QualityBreakdownSheet(
                        first: pair.first,
                        second: pair.second,
                        firstQuality: quality[pair.first.id],
                        secondQuality: quality[pair.second.id]
                    )
                    .presentationDetents([.medium, .large])
                }
            }
        }
    }

    // MARK: - Comparing

    private func comparing(
        _ pair: (first: ReviewQueuePhoto, second: ReviewQueuePhoto)
    ) -> some View {
        GeometryReader { geo in
            let isPortrait = geo.size.height > geo.size.width
            let paneSize = isPortrait
                ? CGSize(width: geo.size.width, height: (geo.size.height - 2) / 2)
                : CGSize(width: (geo.size.width - 2) / 2, height: geo.size.height)
            let zooms = syncedZooms(pair: pair, paneSize: paneSize)
            let layout = isPortrait
                ? AnyLayout(VStackLayout(spacing: 2))
                : AnyLayout(HStackLayout(spacing: 2))

            layout {
                pane(pair.first, indexInPair: 0, zoom: zooms.first,
                     paneSize: paneSize, isPortrait: isPortrait, screen: geo.size)
                pane(pair.second, indexInPair: 1, zoom: zooms.second,
                     paneSize: paneSize, isPortrait: isPortrait, screen: geo.size)
            }
            // The verdicts live in the system bottom bar, not in a strip
            // added here. A `VStack` of panes-plus-bar put the bar past the
            // bottom edge, because the panes are sized against the *whole*
            // GeometryReader and `ComparePane` pins that size — so nothing
            // could shrink to make room (#1091 §1). The bar is chrome: the
            // system reserves its height, this reader measures what is left,
            // and the panes stay as large as the screen allows without
            // covering the photos the way a floating bar would.
            .onAppear { orientationIsPortrait = isPortrait }
            .onChange(of: isPortrait) { _, portrait in
                orientationIsPortrait = portrait
            }
        }
    }

    private func pane(
        _ photo: ReviewQueuePhoto,
        indexInPair: Int,
        zoom: PhotoCompare.Zoom?,
        paneSize: CGSize,
        isPortrait: Bool,
        screen: CGSize
    ) -> some View {
        ComparePane(
            photo: photo,
            image: images[photo.id],
            paneSize: paneSize,
            zoom: zoom,
            faces: showPeaking ? (faces[photo.id] ?? []) : [],
            sharpness: sharpness[photo.id] ?? [],
            qualityPercent: qualityPercent(for: photo),
            flungOffset: flung?.id == photo.id ? flung?.offset : nil,
            discardDisabled: flung != nil,
            onTap: { handleTap(at: $0, photo: photo, paneSize: paneSize) },
            onDrag: { handleFling(
                $0, photo: photo, indexInPair: indexInPair,
                isPortrait: isPortrait, screen: screen
            ) },
            // A directional button in the bottom bar ("throw the top one
            // out") turned out to be exactly as readable as its opposite —
            // reported confusion, and toolbar bottom-bar items render
            // icon-only regardless of `.labelStyle`, so there was never a
            // label to disambiguate it with. Putting the discard action
            // directly on the photo it discards removes the ambiguity
            // instead of trying to caption it: the familiar thumbs-down
            // already used everywhere else in the app (feed, fullscreen
            // viewer, review queue) for "hide this one".
            onDiscard: { discard(photo.id) }
        )
    }

    /// The two verdicts that apply to the *pair*, not to either photo on its
    /// own — discarding one of them lives on the photo itself now (see
    /// `ComparePane`'s thumbs-down).
    ///
    /// A fling is quick but invisible: nothing on screen says it exists, and
    /// nothing about it works with VoiceOver or Switch Control, so both stay
    /// available as buttons too — in the system bottom bar, so their height
    /// is reserved rather than taken from the photos and their insets are
    /// the system's problem.
    @ToolbarContentBuilder
    private func verdictBar(
        _ pair: (first: ReviewQueuePhoto, second: ReviewQueuePhoto)
    ) -> some ToolbarContent {
        ToolbarItemGroup(placement: .bottomBar) {
            verdictButton("Gleich gut", systemImage: "equal.circle") {
                withAnimation { tournament.draw() }
                focus = nil
            }

            Spacer()

            // Not a uturn arrow — that reads as "undo", the opposite of what
            // this does. A skip-forward glyph is the same one media players
            // use for "move on to the next thing", which is exactly this.
            verdictButton("Später", systemImage: "forward.fill") {
                withAnimation { tournament.skip() }
                focus = nil
            }
        }
    }

    private func verdictButton(
        _ title: String,
        systemImage: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Label(title, systemImage: systemImage)
        }
        // While a tile is still flying off the screen its verdict is already
        // committed; a second one would decide a pair that is no longer up.
        .disabled(flung != nil)
        .accessibilityLabel(title)
    }

    // MARK: - Confirming

    /// What the comparisons came to, before anything is committed.
    ///
    /// Nothing has reached the server at this point: the whole tournament is
    /// local, and this one screen is where it turns into a decision. Toggling
    /// a photo here is still free.
    private var confirmation: some View {
        ScrollView {
            LazyVGrid(
                columns: [GridItem(.adaptive(minimum: 110), spacing: 8)],
                spacing: 8
            ) {
                ForEach(tournament.ranked, id: \.self) { id in
                    if let photo = photoById[id] {
                        confirmationTile(photo)
                    }
                }
            }
            .padding(12)
        }
        .background(Color(.systemBackground))
        .safeAreaInset(edge: .bottom) {
            VStack(spacing: 6) {
                Text(keepSummary)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                // Only offered while a pair is genuinely unjudged — ending the
                // comparison used to be one-way, and „weiter vergleichen" on a
                // finished tournament would open an empty screen (#1091 §2c).
                if tournament.hasUnsettledPairs {
                    Button {
                        withAnimation { tournament.resumeComparing() }
                    } label: {
                        Label("Weiter vergleichen", systemImage: "rectangle.on.rectangle")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                }
                Button {
                    onCommit(Array(keepIds).sorted())
                    dismiss()
                } label: {
                    Text("Auswahl übernehmen")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .disabled(keepIds.isEmpty)
            }
            .padding(12)
            .background(.ultraThinMaterial)
        }
    }

    private var keepSummary: String {
        let keep = keepIds.count
        let hide = photos.count - keep
        if keep == 0 {
            return "Mindestens ein Foto muss behalten werden."
        }
        return "\(keep) behalten · \(hide) ausblenden"
    }

    /// One photo in the confirmation.
    ///
    /// A tap on the image opens it full size, because this is the screen where
    /// photos get hidden and it shows them at about 110 pt — deciding from a
    /// thumbnail is the thing the whole comparison exists to avoid. Keeping
    /// and hiding moved onto the check icon, which gets a hit area worth
    /// aiming at rather than the glyph's own size (#1091 §2a, §2b).
    private func confirmationTile(_ photo: ReviewQueuePhoto) -> some View {
        let kept = keepIds.contains(photo.id)
        return PhotoThumbnailView(filename: photo.filename, photoId: photo.id)
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .opacity(kept ? 1 : 0.35)
            .contentShape(RoundedRectangle(cornerRadius: 10))
            .onTapGesture { openCheck(photo.id) }
            .accessibilityLabel("Foto ansehen")
            .overlay(alignment: .bottomLeading) {
                if let percent = qualityPercent(for: photo) {
                    Text("\(percent) %")
                        .font(.caption2.bold())
                        .foregroundStyle(.white)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(.black.opacity(0.6), in: Capsule())
                        .padding(5)
                }
            }
            // On top of the image, so its own hits win over the tap that
            // opens the photo. 44 pt is the smallest thing worth aiming at.
            .overlay(alignment: .topTrailing) {
                keepToggle(photo.id)
            }
    }

    private func keepToggle(_ photoId: Int) -> some View {
        let kept = keepIds.contains(photoId)
        return Button {
            toggleKeep(photoId)
        } label: {
            Image(systemName: kept ? "checkmark.circle.fill" : "circle")
                .font(.title3)
                .foregroundStyle(kept ? Color.accentColor : .white)
                .shadow(radius: 2)
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(kept ? "Behalten, ausgewählt" : "Ausblenden, nicht ausgewählt")
    }

    private func toggleKeep(_ photoId: Int) {
        if keepIds.contains(photoId) {
            keepIds.remove(photoId)
        } else {
            keepIds.insert(photoId)
        }
    }

    /// Open one photo of the group full size, for the last look before
    /// anything is committed.
    private func openCheck(_ photoId: Int) {
        guard !rows.isEmpty else { return }
        checkIndex = rows.firstIndex { $0.id == photoId } ?? 0
        isChecking = true
    }

    /// Keeping and hiding, inside the full-size check — so „look at it, then
    /// decide" does not send the user back to the grid to act on what they
    /// just saw.
    private func checkFooter(photoId: Int) -> some View {
        let kept = keepIds.contains(photoId)
        return HStack(spacing: 12) {
            Button {
                toggleKeep(photoId)
            } label: {
                Label(
                    kept ? "Behalten" : "Ausblenden",
                    systemImage: kept ? "checkmark.circle.fill" : "circle"
                )
                .font(.subheadline.weight(.semibold))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 10)
                .background(
                    kept ? Color.accentColor.opacity(0.14) : Color.secondary.opacity(0.12),
                    in: RoundedRectangle(cornerRadius: 12)
                )
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 16)
        .padding(.top, 10)
        .padding(.bottom, 6)
        .background(.bar)
    }

    // MARK: - Toolbar

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .cancellationAction) {
            Button("Abbrechen") { dismiss() }
        }
        if pair != nil {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    showPeaking.toggle()
                } label: {
                    Label(
                        "Schärfe",
                        systemImage: showPeaking ? "viewfinder.circle.fill" : "viewfinder.circle"
                    )
                }
            }
            ToolbarItem(placement: .primaryAction) {
                Button {
                    showQuality = true
                } label: {
                    Label("Bewertung", systemImage: "chart.bar.doc.horizontal")
                }
            }
            if focus != nil {
                ToolbarItem(placement: .primaryAction) {
                    Button("Ganzes Bild") { focus = nil }
                }
            }
            ToolbarItem(placement: .primaryAction) {
                // The gestures are the fast path and completely invisible;
                // without a legend somewhere they are not discoverable.
                Button {
                    showGestureHelp = true
                } label: {
                    Label("Hilfe", systemImage: "questionmark.circle")
                }
            }
            ToolbarItem(placement: .primaryAction) {
                // Long groups need a way out that is not „compare all fifteen
                // pairs": the scores so far are already an answer.
                Button("Fertig") {
                    withAnimation { tournament.finishComparing() }
                }
            }
        }
        if let pair {
            verdictBar(pair)
        }
        ToolbarItem(placement: .principal) {
            Text(progressLabel)
                .font(.caption)
                .foregroundStyle(.secondary)
                .monospacedDigit()
        }
    }

    private var progressLabel: String {
        if pair == nil { return "\(photos.count) Fotos" }
        return "Vergleich \(tournament.comparisons + 1) von \(tournament.totalPairs)"
    }

    /// The score to show on a photo: the fresh read when there is one, the
    /// queue's own otherwise. A queue entry loaded before the scan finished
    /// shows „?" until this arrives.
    private func qualityPercent(for photo: ReviewQueuePhoto) -> Int? {
        let merged = PhotoQualityDetails.merged(
            score: photo.ai_quality_score,
            details: nil,
            fresh: quality[photo.id]
        )
        return merged.score.map { Int(($0 * 100).rounded()) }
    }

    // MARK: - Zoom

    /// The two zooms, solved as a pair. Nil on either side means that photo is
    /// shown at its plain fit — no image yet, or no face to line up on.
    private func syncedZooms(
        pair: (first: ReviewQueuePhoto, second: ReviewQueuePhoto),
        paneSize: CGSize
    ) -> (first: PhotoCompare.Zoom?, second: PhotoCompare.Zoom?) {
        guard let focus,
              let firstImage = images[pair.first.id],
              let secondImage = images[pair.second.id],
              let boxes = PhotoCompare.matchedBoxes(
                  personId: focus.personId,
                  first: faces[pair.first.id] ?? [],
                  second: faces[pair.second.id] ?? []
              )
        else { return (nil, nil) }

        return PhotoCompare.syncedZoom(
            (bbox: boxes.first, viewport: viewport(paneSize: paneSize, image: firstImage)),
            (bbox: boxes.second, viewport: viewport(paneSize: paneSize, image: secondImage))
        )
    }

    private func viewport(paneSize: CGSize, image: UIImage) -> PhotoCompare.Viewport {
        PhotoCompare.Viewport(
            width: Double(paneSize.width),
            height: Double(paneSize.height),
            photoWidth: Double(image.size.width),
            photoHeight: Double(image.size.height)
        )
    }

    // MARK: - Interaction

    private func handleTap(at location: CGPoint, photo: ReviewQueuePhoto, paneSize: CGSize) {
        // A second tap goes back to the whole picture.
        if focus != nil {
            focus = nil
            return
        }
        guard let image = images[photo.id] else { return }
        guard let point = PhotoCompare.imageCoordinates(
            of: location,
            in: viewport(paneSize: paneSize, image: image)
        ) else { return }
        guard let candidate = PhotoCompare.face(at: point, in: faces[photo.id] ?? []) else {
            return
        }
        // Only a named face can be found in the other photo too; without one
        // each side lines up on whatever it considers its subject.
        focus = candidate.personId.map(Focus.person(id:)) ?? .primary
    }

    /// A drag that ended: discard the photo if it was thrown decisively away
    /// from its partner, otherwise leave it be.
    ///
    /// Skipped while zoomed in, where a drag means panning, and while another
    /// tile is already on its way out.
    private func handleFling(
        _ translation: CGSize,
        photo: ReviewQueuePhoto,
        indexInPair: Int,
        isPortrait: Bool,
        screen: CGSize
    ) {
        guard flung == nil, focus == nil else { return }
        guard let direction = CompareSwipe.discardDirection(
            indexInPair: indexInPair,
            isPortrait: isPortrait,
            dx: Double(translation.width),
            dy: Double(translation.height)
        ) else { return }

        withAnimation(.easeIn(duration: CompareSwipe.animationDuration)) {
            flung = Flung(
                id: photo.id,
                offset: CompareSwipe.offscreenOffset(direction, screen: screen)
            )
        }
        // The verdict waits for the tile to actually leave, so the discard is
        // something the user watches happen rather than a photo that blinks
        // out — and then the *next pair* comes up, rather than the group
        // ending on one gesture.
        let id = photo.id
        Task { @MainActor in
            try? await Task.sleep(
                nanoseconds: UInt64(CompareSwipe.animationDuration * 1_000_000_000)
            )
            discard(id)
        }
    }

    /// Record a verdict and move on. The photo is not hidden here — nothing
    /// reaches the server until the keep set is confirmed.
    private func discard(_ photoId: Int) {
        withAnimation { tournament.discard(photoId) }
        flung = nil
        focus = nil
        if tournament.current == nil { seedKeepIds() }
    }

    /// Fill the confirmation from what the comparisons came to — once.
    ///
    /// „Weiter vergleichen" can bring the user back here a second time, and
    /// re-seeding then would silently undo the toggles they set by hand the
    /// first time round. The proposal is a starting point, not a verdict that
    /// gets re-imposed.
    private func seedKeepIds() {
        guard !didSeedKeep else { return }
        didSeedKeep = true
        keepIds = Set(tournament.suggestedKeepIds)
    }

    // MARK: - Loading

    private func load() async {
        // Only the pair on screen, plus nothing else: a group of ten would
        // otherwise pull ten full-size photos before the first comparison.
        let wanted = [tournament.current?.low, tournament.current?.high]
            .compactMap { $0 }
            .compactMap { photoById[$0] }
        for photo in wanted {
            // The breakdown never comes with the review queue — the queue
            // photo carries a score and nothing else — so it is read per
            // photo here, the same fresh fetch the web makes.
            if quality[photo.id] == nil,
               let fresh = try? await PhotoFetch.byId(photo.id) {
                quality[photo.id] = PhotoQualityDetails.Fresh(fresh)
            }
            if faces[photo.id] == nil,
               let response: ListFacesResponse = try? await APIClient.shared.get(
                   "/photos/\(photo.id)/faces"
               ) {
                faces[photo.id] = response.faces.map { PhotoCompare.Candidate($0) }
            }
            if images[photo.id] == nil,
               let data = try? await APIClient.shared.downloadData(
                   "/photos/file/\(photo.filename)"
               ),
               let image = UIImage(data: data) {
                images[photo.id] = image
            }
            measureSharpness(of: photo)
        }
        if tournament.current == nil {
            seedKeepIds()
            await loadRowsForCheck()
        }
    }

    /// The group's full rows, for the final-check viewer on the confirmation.
    ///
    /// Fetched when the confirmation is reached rather than up front: during
    /// the comparison nothing needs them, and a group of ten would pay for a
    /// batch it might never use.
    private func loadRowsForCheck() async {
        guard rows.isEmpty else { return }
        rows = (try? await PhotoFetch.byIds(tournament.ranked)) ?? []
    }

    /// Measure every face in a photo once both its pixels and its boxes are in.
    ///
    /// Off the main actor: each face is a crop, a redraw and a pass over its
    /// pixels, and a burst of them would otherwise stall the scroll.
    private func measureSharpness(of photo: ReviewQueuePhoto) {
        guard sharpness[photo.id] == nil,
              let cgImage = images[photo.id]?.cgImage,
              let candidates = faces[photo.id], !candidates.isEmpty
        else { return }
        let boxes = candidates.map(\.bbox)
        Task.detached(priority: .userInitiated) {
            let scores = boxes.map { FocusPeaking.sharpness(of: $0, in: cgImage) }
            await MainActor.run { sharpness[photo.id] = scores }
        }
    }
}

/// What the screen can do without a button being pressed.
///
/// The comparison is gesture-first — fling a photo away, tap a face to line
/// both sides up on it — and none of that is visible. Every gesture also has a
/// button, but the buttons do not explain the gestures, so this does (#1091
/// §1).
private struct GestureHelp: View {
    let isPortrait: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Bedienung")
                .font(.headline)
            row(
                "hand.draw",
                "Ein Foto wegwerfen",
                isPortrait
                    ? "Nach oben oder unten aus dem Bild schieben — jede Richtung außer der zum anderen Foto. Oder auf das Daumen-runter-Symbol auf dem Foto tippen."
                    : "Nach links oder rechts aus dem Bild schieben — jede Richtung außer der zum anderen Foto. Oder auf das Daumen-runter-Symbol auf dem Foto tippen."
            )
            row(
                "hand.tap",
                "Gesichter vergleichen",
                "Auf ein Gesicht tippen: beide Fotos zoomen gleich weit darauf. Nochmal tippen zeigt wieder das ganze Bild."
            )
            row(
                "equal.circle",
                "Gleich gut",
                "Das Paar ist erledigt, ohne dass eines gewinnt."
            )
            row(
                "forward.fill",
                "Später",
                "Das Paar wird zurückgestellt und kommt am Ende wieder."
            )
            Divider()
            Text("Nichts wird ausgeblendet, solange die Auswahl am Ende nicht bestätigt ist.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(20)
        .frame(maxWidth: 340)
    }

    private func row(_ systemImage: String, _ title: String, _ detail: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: systemImage)
                .frame(width: 22)
                .foregroundStyle(.tint)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.subheadline.weight(.semibold))
                Text(detail).font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}

/// One half of the comparison.
private struct ComparePane: View {
    let photo: ReviewQueuePhoto
    let image: UIImage?
    let paneSize: CGSize
    let zoom: PhotoCompare.Zoom?
    let faces: [PhotoCompare.Candidate]
    let sharpness: [Double?]
    /// The AI score to show, already merged with a fresh read.
    let qualityPercent: Int?
    /// Where this pane has been thrown, if it is being discarded.
    let flungOffset: CGSize?
    /// Mirrors the parent's "a tile is already on its way out" guard onto
    /// this pane's own discard button.
    let discardDisabled: Bool
    let onTap: (CGPoint) -> Void
    /// The total translation of a finished drag.
    let onDrag: (CGSize) -> Void
    /// Discards *this* photo — the button form of the fling gesture,
    /// attached to the photo it acts on rather than a direction in a bar
    /// below both photos.
    let onDiscard: () -> Void

    var body: some View {
        ZStack {
            Color.black
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .overlay { peaking(image: image) }
                    .scaleEffect(zoom?.zoom ?? 1)
                    .offset(zoom?.offset ?? .zero)
                    .animation(.easeInOut(duration: 0.25), value: zoom?.zoom)
            } else {
                ProgressView().tint(.white)
            }
        }
        .frame(width: paneSize.width, height: paneSize.height)
        .clipped()
        .contentShape(Rectangle())
        .offset(flungOffset ?? .zero)
        .opacity(flungOffset == nil ? 1 : 0)
        .onTapGesture { location in onTap(location) }
        // Simultaneous so a fling does not swallow the tap that zooms to a
        // face; `CompareSwipe` decides which of the two a gesture was.
        .simultaneousGesture(
            DragGesture(minimumDistance: 20)
                .onEnded { onDrag($0.translation) }
        )
        .overlay(alignment: .topLeading) {
            if let percent = qualityPercent {
                Text("\(percent) %")
                    .font(.caption.bold())
                    .foregroundStyle(.white)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(.black.opacity(0.6), in: Capsule())
                    .padding(6)
            }
        }
        // Bottom-trailing so it never sits under the quality badge
        // (top-leading) or a face frame drawn near the photo's centre.
        .overlay(alignment: .bottomTrailing) {
            discardButton
        }
    }

    /// The same thumbs-down used everywhere else in the app for "hide this
    /// one" (feed, fullscreen viewer, review queue) — so this reads as the
    /// same action rather than a new one invented for this screen.
    private var discardButton: some View {
        Button(action: onDiscard) {
            Image(systemName: "hand.thumbsdown")
                .font(.title3)
                .foregroundStyle(.white)
                .shadow(radius: 2)
                .frame(width: 44, height: 44)
                .background(.black.opacity(0.35), in: Circle())
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(discardDisabled)
        .padding(6)
        .accessibilityLabel("Dieses Foto ausblenden")
    }

    /// A frame around each measured face, coloured by how sharp it is.
    ///
    /// Drawn inside the image's own space so the boxes track the photo as it
    /// zooms; the border and label counter-scale so they stay the same size on
    /// screen instead of thickening into a smudge.
    @ViewBuilder
    private func peaking(image: UIImage) -> some View {
        GeometryReader { geo in
            let chrome = FocusPeaking.chromeScale(zoom: zoom?.zoom ?? 1)
            ForEach(faces.indices, id: \.self) { index in
                if let score = sharpness[safe: index] ?? nil {
                    let bbox = faces[index].bbox
                    let width = bbox.width * Double(geo.size.width)
                    let height = bbox.height * Double(geo.size.height)
                    // A face rendered this small says nothing framed, and a
                    // crowd of overlapping labels says less than none.
                    if FocusPeaking.isLegible(
                        width: width * (zoom?.zoom ?? 1),
                        height: height * (zoom?.zoom ?? 1)
                    ) {
                        PeakingFrame(score: score, chromeScale: chrome)
                            .frame(width: width, height: height)
                            .position(
                                x: (bbox.x + bbox.width / 2) * Double(geo.size.width),
                                y: (bbox.y + bbox.height / 2) * Double(geo.size.height)
                            )
                    }
                }
            }
        }
        .allowsHitTesting(false)
    }
}

/// One face's frame: the traffic-light border and its percentage.
private struct PeakingFrame: View {
    let score: Double
    let chromeScale: Double

    private var color: Color {
        switch FocusPeaking.classify(score) {
        case .sharp: return .green
        case .medium: return .yellow
        case .unsharp: return .red
        }
    }

    var body: some View {
        Rectangle()
            .strokeBorder(color, lineWidth: 2 * chromeScale)
            .overlay(alignment: .bottomLeading) {
                Text(FocusPeaking.label(score: score))
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(.black)
                    .padding(.horizontal, 3)
                    .background(color)
                    .scaleEffect(chromeScale, anchor: .bottomLeading)
            }
            .accessibilityLabel(FocusPeaking.describe(score: score))
    }
}

private extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}

/// The score, broken into what it was made of.
///
/// Two photos of the same moment scoring 71 % and 68 % says nothing about
/// why. This says one is sharper and the other better composed, which is what
/// actually decides which to keep.
private struct QualityBreakdownSheet: View {
    let first: ReviewQueuePhoto
    let second: ReviewQueuePhoto
    let firstQuality: PhotoQualityDetails.Fresh?
    let secondQuality: PhotoQualityDetails.Fresh?

    @Environment(\.dismiss) private var dismiss

    private var rows: [PhotoQualityDetails.Row] {
        PhotoQualityDetails.rows(
            first: firstQuality?.details,
            second: secondQuality?.details
        )
    }

    var body: some View {
        NavigationStack {
            Group {
                if rows.isEmpty {
                    ContentUnavailableView(
                        "Keine Bewertung",
                        systemImage: "chart.bar.doc.horizontal",
                        description: Text("Für diese Fotos liegt noch keine KI-Bewertung vor.")
                    )
                } else {
                    List {
                        Section {
                            ForEach(rows) { row in
                                criterion(row)
                            }
                        } header: {
                            HStack {
                                Text("Kriterium")
                                Spacer()
                                Text("Links")
                                    .frame(width: 54, alignment: .trailing)
                                Text("Rechts")
                                    .frame(width: 54, alignment: .trailing)
                            }
                        } footer: {
                            // Typographic quotes here, not an escaped ASCII
                            // one: a stray \" is what broke this build.
                            Text("„–“ heißt: für dieses Foto wurde das Kriterium nicht gemessen — nicht, dass es null Punkte bekam.")
                        }
                    }
                }
            }
            .navigationTitle("Bewertung")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Fertig") { dismiss() }
                }
            }
        }
    }

    private func criterion(_ row: PhotoQualityDetails.Row) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(row.label)
                Spacer()
                value(row.first, isLeader: row.leader == .first)
                value(row.second, isLeader: row.leader == .second)
            }
            HStack(spacing: 4) {
                bar(row.first, isLeader: row.leader == .first)
                bar(row.second, isLeader: row.leader == .second)
            }
        }
        .padding(.vertical, 2)
    }

    private func value(_ score: Double?, isLeader: Bool) -> some View {
        Text(PhotoQualityDetails.percent(score))
            .font(.callout.monospacedDigit())
            .fontWeight(isLeader ? .bold : .regular)
            .foregroundStyle(isLeader ? Color.accentColor : .secondary)
            .frame(width: 54, alignment: .trailing)
    }

    private func bar(_ score: Double?, isLeader: Bool) -> some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(.quaternary)
                Capsule()
                    .fill(isLeader ? Color.accentColor : Color.secondary)
                    .frame(width: geo.size.width * CGFloat(score ?? 0))
            }
        }
        .frame(height: 4)
    }
}

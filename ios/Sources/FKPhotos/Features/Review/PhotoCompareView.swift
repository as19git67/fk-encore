import SwiftUI
import UIKit

/// Two shots of the same moment, side by side, so the sharper one is obvious.
///
/// The web's `PhotoCompareView` in its comparison half (#1021, stage A). The
/// deciding move is the same one: tap a face and **both** photos zoom to it at
/// the same on-screen size. Two independently-zoomed faces cannot be compared;
/// matched ones can. The geometry is in `PhotoCompare`.
///
/// The two zooms are solved **together, here** — each needs the other photo's
/// dimensions, so a pane cannot work its own out alone without the two halves
/// disagreeing.
///
/// A photo can also be thrown off the screen to drop it (`CompareSwipe`),
/// which is the web's fling gesture — every direction discards except the one
/// pointing at the partner photo, and the quality breakdown
/// (`PhotoQualityDetails`) says *why* one photo scored higher than the other.
/// The full keep set still belongs to `ReviewSelectionSheet`.
struct PhotoCompareView: View {
    let first: ReviewQueuePhoto
    let second: ReviewQueuePhoto
    /// Called with the photo that was flung away. The caller decides what a
    /// discard means for the group — this view only reports the gesture.
    var onDiscard: ((Int) -> Void)?

    @Environment(\.dismiss) private var dismiss

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

    var body: some View {
        NavigationStack {
            GeometryReader { geo in
                let isPortrait = geo.size.height > geo.size.width
                let paneSize = isPortrait
                    ? CGSize(width: geo.size.width, height: (geo.size.height - 2) / 2)
                    : CGSize(width: (geo.size.width - 2) / 2, height: geo.size.height)
                let zooms = syncedZooms(paneSize: paneSize)
                let layout = isPortrait
                    ? AnyLayout(VStackLayout(spacing: 2))
                    : AnyLayout(HStackLayout(spacing: 2))

                layout {
                    ComparePane(
                        photo: first,
                        image: images[first.id],
                        paneSize: paneSize,
                        zoom: zooms.first,
                        faces: showPeaking ? (faces[first.id] ?? []) : [],
                        sharpness: sharpness[first.id] ?? [],
                        qualityPercent: qualityPercent(for: first),
                        flungOffset: flung?.id == first.id ? flung?.offset : nil,
                        onTap: { handleTap(at: $0, photo: first, paneSize: paneSize) },
                        onDrag: { handleFling(
                            $0, photo: first, indexInPair: 0,
                            isPortrait: isPortrait, screen: geo.size
                        ) }
                    )
                    ComparePane(
                        photo: second,
                        image: images[second.id],
                        paneSize: paneSize,
                        zoom: zooms.second,
                        faces: showPeaking ? (faces[second.id] ?? []) : [],
                        sharpness: sharpness[second.id] ?? [],
                        qualityPercent: qualityPercent(for: second),
                        flungOffset: flung?.id == second.id ? flung?.offset : nil,
                        onTap: { handleTap(at: $0, photo: second, paneSize: paneSize) },
                        onDrag: { handleFling(
                            $0, photo: second, indexInPair: 1,
                            isPortrait: isPortrait, screen: geo.size
                        ) }
                    )
                }
            }
            .background(Color.black)
            .navigationTitle("Vergleich")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Fertig") { dismiss() }
                }
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
            }
            .task { await load() }
            .sheet(isPresented: $showQuality) {
                QualityBreakdownSheet(
                    first: first,
                    second: second,
                    firstQuality: quality[first.id],
                    secondQuality: quality[second.id]
                )
                .presentationDetents([.medium, .large])
            }
        }
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
        paneSize: CGSize
    ) -> (first: PhotoCompare.Zoom?, second: PhotoCompare.Zoom?) {
        guard let focus,
              let firstImage = images[first.id],
              let secondImage = images[second.id],
              let boxes = PhotoCompare.matchedBoxes(
                  personId: focus.personId,
                  first: faces[first.id] ?? [],
                  second: faces[second.id] ?? []
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
        // The decision waits for the tile to actually leave, so the discard is
        // something the user watches happen rather than a photo that blinks out.
        let id = photo.id
        Task {
            try? await Task.sleep(
                nanoseconds: UInt64(CompareSwipe.animationDuration * 1_000_000_000)
            )
            onDiscard?(id)
            dismiss()
        }
    }

    // MARK: - Loading

    private func load() async {
        for photo in [first, second] {
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
    let onTap: (CGPoint) -> Void
    /// The total translation of a finished drag.
    let onDrag: (CGSize) -> Void

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

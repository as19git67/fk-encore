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
/// Choosing which to keep stays with `ReviewSelectionSheet`; the sharpness
/// overlay and the quality table are stage B.
struct PhotoCompareView: View {
    let first: ReviewQueuePhoto
    let second: ReviewQueuePhoto

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

    /// What the two sides line up on.
    private enum Focus: Equatable {
        /// The same person in both — the best case, and what a tap on a named
        /// face gives.
        case person(id: Int)
        /// A tapped face with no person attached. There is nothing to match
        /// across, so each side falls back to its own primary face.
        case primary
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
                        onTap: { handleTap(at: $0, photo: first, paneSize: paneSize) }
                    )
                    ComparePane(
                        photo: second,
                        image: images[second.id],
                        paneSize: paneSize,
                        zoom: zooms.second,
                        faces: showPeaking ? (faces[second.id] ?? []) : [],
                        sharpness: sharpness[second.id] ?? [],
                        onTap: { handleTap(at: $0, photo: second, paneSize: paneSize) }
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
                if focus != nil {
                    ToolbarItem(placement: .primaryAction) {
                        Button("Ganzes Bild") { focus = nil }
                    }
                }
            }
            .task { await load() }
        }
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
              let firstBox = box(for: first, focus: focus),
              let secondBox = box(for: second, focus: focus)
        else { return (nil, nil) }

        return PhotoCompare.syncedZoom(
            (bbox: firstBox, viewport: viewport(paneSize: paneSize, image: firstImage)),
            (bbox: secondBox, viewport: viewport(paneSize: paneSize, image: secondImage))
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

    private func box(for photo: ReviewQueuePhoto, focus: Focus) -> PhotoCompare.BBox? {
        let candidates = faces[photo.id] ?? []
        switch focus {
        case .person(let id):
            return PhotoCompare.face(forPerson: id, in: candidates)?.bbox
        case .primary:
            return PhotoCompare.primaryFace(in: candidates)?.bbox
        }
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

    // MARK: - Loading

    private func load() async {
        for photo in [first, second] {
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
    let onTap: (CGPoint) -> Void

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
        .onTapGesture { location in onTap(location) }
        .overlay(alignment: .topLeading) {
            if let percent = photo.qualityPercent {
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

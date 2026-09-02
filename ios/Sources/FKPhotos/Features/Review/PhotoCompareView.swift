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
                        onTap: { handleTap(at: $0, photo: first, paneSize: paneSize) }
                    )
                    ComparePane(
                        photo: second,
                        image: images[second.id],
                        paneSize: paneSize,
                        zoom: zooms.second,
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
        }
    }
}

/// One half of the comparison.
private struct ComparePane: View {
    let photo: ReviewQueuePhoto
    let image: UIImage?
    let paneSize: CGSize
    let zoom: PhotoCompare.Zoom?
    let onTap: (CGPoint) -> Void

    var body: some View {
        ZStack {
            Color.black
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
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
}

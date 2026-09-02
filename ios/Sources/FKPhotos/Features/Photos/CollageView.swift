import SwiftUI
import UIKit

/// Arranging a handful of selected photos into a collage.
///
/// The web's `CollageDialog` (#1020): pick one of the three variants for this
/// many photos, see the result, and reorder by tapping two cells. The layout rules are in `CollageLayouts`, shared with
/// the web so a collage of the same photos comes out the same shape.
///
/// Saving renders the canvas on the device and uploads the result as an
/// ordinary photo — there is no collage endpoint, so this is the same move the
/// web makes. The collage inherits the capture date of its **oldest** source,
/// so it sorts beside the photos it was made from rather than at "now".
struct CollageView: View {
    let photos: [PhotoWithCuration]

    @Environment(\.dismiss) private var dismiss
    @State private var layoutIndex = 0
    /// Which photo sits in which cell — indices into `photos`.
    @State private var order: [Int]
    /// The first tapped cell of a swap, if a swap is half-made.
    @State private var swapAnchor: Int?
    @State private var isSaving = false
    @State private var statusMessage: String?
    @State private var didSave = false

    init(photos: [PhotoWithCuration]) {
        self.photos = photos
        _order = State(initialValue: Array(photos.indices))
    }

    private var layouts: [CollageLayouts.Layout] {
        CollageLayouts.layouts(for: photos.count)
    }

    private var layout: CollageLayouts.Layout? {
        layouts.indices.contains(layoutIndex) ? layouts[layoutIndex] : nil
    }

    var body: some View {
        NavigationStack {
            Group {
                if let layout {
                    content(layout: layout)
                } else {
                    ContentUnavailableView {
                        Label("Keine Collage möglich", systemImage: "square.grid.2x2")
                    } description: {
                        Text("Eine Collage braucht \(CollageLayouts.minPhotos) bis \(CollageLayouts.maxPhotos) Fotos — ausgewählt sind \(photos.count).")
                    }
                }
            }
            .navigationTitle("Collage")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Fertig") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isSaving {
                        ProgressView()
                    } else {
                        Button("Sichern") { Task { await save() } }
                            .disabled(layout == nil || didSave)
                    }
                }
            }
        }
    }

    private func content(layout: CollageLayouts.Layout) -> some View {
        VStack(spacing: 16) {
            CollageCanvas(
                layout: layout,
                photos: order.map { photos[$0] },
                highlighted: swapAnchor,
                onTapCell: handleTap
            )
            .padding(.horizontal)

            Picker("Aufteilung", selection: $layoutIndex) {
                ForEach(layouts.indices, id: \.self) { index in
                    Text(layouts[index].name).tag(index)
                }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal)

            Text(swapAnchor == nil
                 ? "Tippe zwei Felder an, um die Fotos zu tauschen."
                 : "Tippe das Feld an, mit dem getauscht werden soll.")
                .font(.caption)
                .foregroundStyle(.secondary)

            if let statusMessage {
                Text(statusMessage)
                    .font(.caption)
                    .foregroundStyle(didSave ? Color.secondary : Color.red)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal)
            }

            Spacer()
        }
        .padding(.top)
    }

    // MARK: - Saving

    /// Render the collage at full size and upload it as a new photo.
    ///
    /// The preview is built from thumbnails; the render needs the originals,
    /// so they are fetched here rather than reused. A photo that cannot be
    /// fetched costs its cell, not the collage.
    @MainActor
    private func save() async {
        guard let layout else { return }
        isSaving = true
        statusMessage = nil
        defer { isSaving = false }

        var tiles: [CollageRenderer.Tile] = []
        for index in order {
            let photo = photos[index]
            guard let data = try? await APIClient.shared.downloadData(
                "/photos/file/\(photo.filename)"
            ), let image = UIImage(data: data) else { continue }
            tiles.append(CollageRenderer.Tile(image: image, focal: photo.auto_crop.map { CGPoint(x: $0.x, y: $0.y) }))
        }

        guard !tiles.isEmpty,
              let rendered = CollageRenderer.render(layout: layout, tiles: tiles),
              let jpeg = rendered.jpegData(compressionQuality: 0.9)
        else {
            statusMessage = "Die Collage konnte nicht erzeugt werden."
            return
        }

        let filename = CollageRenderer.filename()
        let imageDataHash = PhotoHasher.imageDataHash(from: jpeg)
        let fullHash = PhotoHasher.fullHash(
            imageDataHash: imageDataHash,
            caption: "",
            isFavorite: false,
            capturedAtString: ""
        )
        do {
            _ = try await APIClient.shared.uploadPhoto(
                data: jpeg,
                filename: filename,
                mimeType: "image/jpeg",
                imageDataHash: imageDataHash,
                fullHash: fullHash,
                caption: "",
                isFavorite: false,
                capturedAtString: "",
                // A collage has no library asset behind it; the id is what the
                // sync protocol keys on, so it gets the filename it was made
                // under rather than an empty string.
                assetLocalId: filename,
                dateTaken: CollageRenderer.inheritedDate(from: order.map { photos[$0] })
            )
            didSave = true
            statusMessage = "Collage gesichert."
        } catch {
            statusMessage = error.localizedDescription
        }
    }

    /// Two taps make a swap: the first marks a cell, the second exchanges them.
    private func handleTap(_ cellIndex: Int) {
        guard let anchor = swapAnchor else {
            swapAnchor = cellIndex
            return
        }
        if anchor != cellIndex {
            order = CollageLayouts.swap(order, anchor, cellIndex)
        }
        swapAnchor = nil
    }
}

/// The collage itself: the canvas at its layout's aspect, each cell filled
/// with its photo.
private struct CollageCanvas: View {
    let layout: CollageLayouts.Layout
    let photos: [PhotoWithCuration]
    let highlighted: Int?
    let onTapCell: (Int) -> Void

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .topLeading) {
                Color(.secondarySystemBackground)
                ForEach(layout.cells.indices, id: \.self) { index in
                    if let photo = photos[safe: index] {
                        cell(layout.cells[index], photo: photo, index: index, canvas: geo.size)
                    }
                }
            }
        }
        .aspectRatio(layout.aspect, contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private func cell(
        _ cell: CollageLayouts.Cell,
        photo: PhotoWithCuration,
        index: Int,
        canvas: CGSize
    ) -> some View {
        let width = cell.width * canvas.width
        let height = cell.height * canvas.height
        return PhotoThumbnailView(filename: photo.filename, autoCrop: photo.auto_crop)
            .frame(width: width, height: height)
            .clipped()
            .overlay {
                if highlighted == index {
                    Rectangle()
                        .strokeBorder(Color.accentColor, lineWidth: 3)
                }
            }
            .contentShape(Rectangle())
            .onTapGesture { onTapCell(index) }
            .offset(x: cell.x * canvas.width, y: cell.y * canvas.height)
    }
}

private extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}

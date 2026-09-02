import SwiftUI
import UIKit

/// Arranging a handful of selected photos into a collage.
///
/// The web's `CollageDialog` in its layout half (#1020, stage A): pick one of
/// the three variants for this many photos, see the result, and reorder by
/// tapping two cells. The layout rules are in `CollageLayouts`, shared with
/// the web so a collage of the same photos comes out the same shape.
///
/// **Nothing is saved yet.** There is no collage endpoint — the web renders
/// the canvas itself and uploads the result as an ordinary photo, which needs
/// an on-device render this stage does not have. Stage B adds that; this shows
/// what would be built.
struct CollageView: View {
    let photos: [PhotoWithCuration]

    @Environment(\.dismiss) private var dismiss
    @State private var layoutIndex = 0
    /// Which photo sits in which cell — indices into `photos`.
    @State private var order: [Int]
    /// The first tapped cell of a swap, if a swap is half-made.
    @State private var swapAnchor: Int?

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

            Text("Das Speichern der Collage kommt noch (#1020).")
                .font(.caption2)
                .foregroundStyle(.tertiary)

            Spacer()
        }
        .padding(.top)
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

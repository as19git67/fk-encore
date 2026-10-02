import SwiftUI
import UIKit

/// Arranging a handful of selected photos into a collage.
///
/// The web's `CollageDialog` (#1020): pick one of the three variants for this
/// many photos, see the result, and rearrange by dragging one photo onto
/// another — as on the web — or by tapping two cells in turn. The layout
/// rules are in `CollageLayouts`, shared with the web so a collage of the
/// same photos comes out the same shape.
///
/// A caption can be laid over the whole canvas (#1020, stage C): dragged into
/// place, in one of three sizes, in white, black or a colour taken from the
/// photos themselves. The rules are in `CollageText`, shared with the web.
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
    /// The captions laid over the canvas, and which one is being edited.
    @State private var overlays: [CollageText.Overlay] = []
    @State private var editing: CollageText.Overlay.ID?
    /// White and black, plus whatever colours the photos turned out to have.
    @State private var palette: [String] = CollageText.fixedColors
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
            .task { await loadPalette() }
            // Dragging a photo downward must move the photo, not pull the
            // sheet away with the arrangement in it; "Fertig" closes.
            .interactiveDismissDisabled()
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
                overlays: overlays,
                editingOverlay: editing,
                onTapCell: handleTap,
                onSwapCells: swapCells,
                onSelectOverlay: { editing = $0 },
                onMoveOverlay: move
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
                 ? "Zum Tauschen ein Foto auf ein anderes ziehen – oder zwei nacheinander antippen."
                 : "Tippe das Feld an, mit dem getauscht werden soll.")
                .multilineTextAlignment(.center)
                .padding(.horizontal)
                .font(.caption)
                .foregroundStyle(.secondary)

            textControls
                .padding(.horizontal)

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

    // MARK: - Text

    /// The caption being edited, if any.
    private var editingIndex: Int? {
        overlays.firstIndex { $0.id == editing }
    }

    @ViewBuilder
    private var textControls: some View {
        if let index = editingIndex {
            VStack(spacing: 8) {
                TextField("Text", text: Binding(
                    get: { overlays[index].text },
                    set: { overlays[index].text = $0 }
                ), axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .lineLimit(1...3)

                HStack {
                    Picker("Größe", selection: Binding(
                        get: { overlays[index].fontKey },
                        set: { overlays[index].fontKey = $0 }
                    )) {
                        ForEach(CollageText.fonts) { preset in
                            Text(preset.label).tag(preset.key)
                        }
                    }
                    .pickerStyle(.segmented)

                    Picker("Ausrichtung", selection: Binding(
                        get: { overlays[index].align },
                        set: { overlays[index].align = $0 }
                    )) {
                        Image(systemName: "text.alignleft").tag(CollageText.Align.left)
                        Image(systemName: "text.aligncenter").tag(CollageText.Align.center)
                        Image(systemName: "text.alignright").tag(CollageText.Align.right)
                    }
                    .pickerStyle(.segmented)
                    .frame(width: 140)
                }

                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(palette, id: \.self) { hex in
                            swatch(hex, index: index)
                        }
                    }
                    .padding(.vertical, 2)
                }

                HStack {
                    Button("Fertig") { editing = nil }
                    Spacer()
                    Button("Text entfernen", role: .destructive) {
                        overlays.remove(at: index)
                        editing = nil
                    }
                }
                .font(.callout)
            }
        } else {
            Button {
                let overlay = CollageText.newOverlay(existingCount: overlays.count)
                overlays.append(overlay)
                editing = overlay.id
            } label: {
                Label("Text hinzufügen", systemImage: "textformat")
            }
            .font(.callout)
        }
    }

    private func swatch(_ hex: String, index: Int) -> some View {
        let selected = overlays[index].colorHex == hex
        return Button {
            overlays[index].colorHex = hex
        } label: {
            Circle()
                .fill(Color(CollageText.color(fromHex: hex) ?? .white))
                .frame(width: 26, height: 26)
                .overlay {
                    Circle().strokeBorder(
                        selected ? Color.accentColor : Color.secondary.opacity(0.4),
                        lineWidth: selected ? 3 : 1
                    )
                }
        }
        .buttonStyle(.plain)
    }

    private func move(_ id: CollageText.Overlay.ID, dx: Double, dy: Double) {
        guard let index = overlays.firstIndex(where: { $0.id == id }) else { return }
        overlays[index] = CollageText.moved(overlays[index], byX: dx, y: dy)
    }

    /// Read the colours out of the photos so the caption can be tinted with
    /// one of them.
    ///
    /// Only the first few photos are sampled: a nine-photo collage would
    /// otherwise decode nine full images to fill a row of six swatches. The
    /// images come from the same cache the preview thumbnails use, so this is
    /// usually free.
    @MainActor
    private func loadPalette() async {
        var images: [UIImage] = []
        await TransformedPhotosIndex.shared.load()
        for photo in photos.prefix(3) {
            let source = TransformedPhotosIndex.shared.request(
                photoId: photo.id, filename: photo.filename
            )
            if let cached = await ImageCache.shared.image(forKey: source.cacheKey) {
                images.append(cached)
            } else if let data = try? await APIClient.shared.downloadData(
                source.path, query: source.query.isEmpty ? nil : source.query
            ), let image = UIImage(data: data) {
                images.append(image)
            }
        }
        guard !images.isEmpty else { return }
        palette = CollageText.palette(from: images)
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
        await TransformedPhotosIndex.shared.load()
        for index in order {
            let photo = photos[index]
            // Full resolution: no `w`, so an edited photo comes back rendered
            // through its recipe at full size, exactly as the preview tile
            // showed it.
            let source = TransformedPhotosIndex.shared.request(
                photoId: photo.id, filename: photo.filename
            )
            guard let data = try? await APIClient.shared.downloadData(
                source.path, query: source.query.isEmpty ? nil : source.query
            ), let image = UIImage(data: data) else { continue }
            // A recipe-rendered photo is already framed by its owner; the AI's
            // focal point belongs to the original frame and would re-shift it.
            let focal = TransformedPhotosIndex.shared.hasRecipe(photo.id)
                ? nil
                : photo.auto_crop.map { CGPoint(x: $0.x, y: $0.y) }
            tiles.append(CollageRenderer.Tile(image: image, focal: focal))
        }

        guard !tiles.isEmpty,
              let rendered = CollageRenderer.render(
                  layout: layout, tiles: tiles, overlays: overlays
              ),
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

    /// A photo dragged onto another cell trades places with it. A half-made
    /// tap swap is dropped, since the drag has already said where things go.
    private func swapCells(_ from: Int, _ to: Int) {
        order = CollageLayouts.swap(order, from, to)
        swapAnchor = nil
    }
}

/// The collage itself: the canvas at its layout's aspect, each cell filled
/// with its photo.
private struct CollageCanvas: View {
    let layout: CollageLayouts.Layout
    let photos: [PhotoWithCuration]
    let highlighted: Int?
    let overlays: [CollageText.Overlay]
    let editingOverlay: CollageText.Overlay.ID?
    let onTapCell: (Int) -> Void
    let onSwapCells: (Int, Int) -> Void
    let onSelectOverlay: (CollageText.Overlay.ID?) -> Void
    let onMoveOverlay: (CollageText.Overlay.ID, Double, Double) -> Void

    /// Where a caption was when its drag began, so the gesture applies to a
    /// fixed base rather than compounding its own output.
    @State private var dragStart: (id: CollageText.Overlay.ID, x: Double, y: Double)?

    /// A photo being dragged to another cell: where it came from, which cell
    /// is under the finger, and where the finger is.
    @State private var photoDragFrom: Int?
    @State private var photoDragOver: Int?
    @State private var photoDragLocation: CGPoint?

    private static let space = "collageCanvas"

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .topLeading) {
                Color(.secondarySystemBackground)
                ForEach(layout.cells.indices, id: \.self) { index in
                    if let photo = photos[safe: index] {
                        cell(layout.cells[index], photo: photo, index: index, canvas: geo.size)
                    }
                }
                ForEach(overlays) { overlay in
                    caption(overlay, canvas: geo.size)
                }
                dragGhost
            }
            .coordinateSpace(name: Self.space)
        }
        .aspectRatio(layout.aspect, contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    /// The dragged photo, small, under the finger — the web's drag ghost.
    @ViewBuilder
    private var dragGhost: some View {
        if let from = photoDragFrom, let location = photoDragLocation,
           let photo = photos[safe: from] {
            PhotoThumbnailView(filename: photo.filename, autoCrop: photo.auto_crop, photoId: photo.id)
                .frame(width: 80, height: 80)
                .clipShape(RoundedRectangle(cornerRadius: 6))
                .shadow(color: .black.opacity(0.35), radius: 8, y: 4)
                .opacity(0.9)
                .position(location)
                .allowsHitTesting(false)
        }
    }

    /// Drag a photo onto another cell to swap the two, as on the web. The
    /// short minimum distance leaves a plain tap to `onTapCell`.
    private func photoDrag(from index: Int, canvas: CGSize) -> some Gesture {
        DragGesture(minimumDistance: 8, coordinateSpace: .named(Self.space))
            .onChanged { value in
                if photoDragFrom == nil { photoDragFrom = index }
                photoDragLocation = value.location
                photoDragOver = cellIndex(at: value.location, canvas: canvas)
            }
            .onEnded { value in
                if let from = photoDragFrom,
                   let to = cellIndex(at: value.location, canvas: canvas),
                   to != from {
                    onSwapCells(from, to)
                }
                photoDragFrom = nil
                photoDragOver = nil
                photoDragLocation = nil
            }
    }

    private func cellIndex(at point: CGPoint, canvas: CGSize) -> Int? {
        guard canvas.width > 0, canvas.height > 0 else { return nil }
        return CollageLayouts.cellIndex(
            at: CGPoint(x: point.x / canvas.width, y: point.y / canvas.height),
            in: layout
        )
    }

    private func caption(_ overlay: CollageText.Overlay, canvas: CGSize) -> some View {
        CollageCaption(
            overlay: overlay,
            canvas: canvas,
            isEditing: editingOverlay == overlay.id
        )
        .position(
            x: CollageText.clampUnit(overlay.x) * canvas.width,
            y: CollageText.clampUnit(overlay.y) * canvas.height
        )
        .onTapGesture { onSelectOverlay(overlay.id) }
        .gesture(
            DragGesture()
                .onChanged { value in
                    if dragStart?.id != overlay.id {
                        dragStart = (overlay.id, overlay.x, overlay.y)
                        onSelectOverlay(overlay.id)
                    }
                    guard let start = dragStart else { return }
                    // The move is applied to where the drag began, expressed
                    // as a delta from the caption's current position.
                    let targetX = start.x + Double(value.translation.width / max(canvas.width, 1))
                    let targetY = start.y + Double(value.translation.height / max(canvas.height, 1))
                    onMoveOverlay(overlay.id, targetX - overlay.x, targetY - overlay.y)
                }
                .onEnded { _ in dragStart = nil }
        )
    }

    private func cell(
        _ cell: CollageLayouts.Cell,
        photo: PhotoWithCuration,
        index: Int,
        canvas: CGSize
    ) -> some View {
        let width = cell.width * canvas.width
        let height = cell.height * canvas.height
        let isDropTarget = photoDragOver == index && photoDragFrom != index
        return PhotoThumbnailView(filename: photo.filename, autoCrop: photo.auto_crop, photoId: photo.id)
            .frame(width: width, height: height)
            .clipped()
            .opacity(photoDragFrom == index ? 0.4 : 1)
            .overlay {
                if highlighted == index || isDropTarget {
                    Rectangle()
                        .strokeBorder(Color.accentColor, lineWidth: 3)
                }
            }
            .contentShape(Rectangle())
            .onTapGesture { onTapCell(index) }
            .gesture(photoDrag(from: index, canvas: canvas))
            .offset(x: cell.x * canvas.width, y: cell.y * canvas.height)
    }
}

/// One caption on the preview.
///
/// The font size is a fraction of the *preview's* height, the same fraction
/// the render applies to the 2400 px canvas, so the caption covers the same
/// share of the picture in both.
///
/// Where the two can still differ: SwiftUI breaks the lines here, while the
/// render uses `CollageText.wrapLines` against measured widths. Both wrap
/// between words at 90 % of the width, so a long caption can land its last
/// word on a different line — the size and the position agree, the exact
/// break is not promised.
private struct CollageCaption: View {
    let overlay: CollageText.Overlay
    let canvas: CGSize
    let isEditing: Bool

    var body: some View {
        let size = CollageText.fontSize(
            for: overlay, canvasHeight: Double(canvas.height)
        )
        Text(overlay.text.isEmpty ? "Text" : overlay.text)
            .font(.system(size: CGFloat(size), weight: .bold))
            .foregroundStyle(Color(CollageText.color(fromHex: overlay.colorHex) ?? .white))
            .multilineTextAlignment(alignment)
            .shadow(color: .black.opacity(0.7), radius: 0, x: 1, y: 1)
            .shadow(color: .black.opacity(0.7), radius: 0, x: -1, y: -1)
            .opacity(overlay.text.isEmpty ? 0.5 : 1)
            .frame(maxWidth: canvas.width * CGFloat(CollageText.widthFraction))
            .padding(4)
            .overlay {
                if isEditing {
                    RoundedRectangle(cornerRadius: 4)
                        .strokeBorder(Color.accentColor, style: StrokeStyle(lineWidth: 1, dash: [4]))
                }
            }
    }

    private var alignment: TextAlignment {
        switch overlay.align {
        case .left: return .leading
        case .center: return .center
        case .right: return .trailing
        }
    }
}

private extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}

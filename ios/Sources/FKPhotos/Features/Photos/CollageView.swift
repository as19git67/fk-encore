import SwiftUI
import UIKit

/// Arranging a handful of selected photos into a collage.
///
/// The web's `CollageDialog` (#1020), in the same two steps: first the three
/// variants for this many photos, each drawn with the photos themselves; then
/// the chosen one large, to rearrange by dragging one photo onto another — or
/// by tapping two cells in turn — and to caption. The layout rules are in
/// `CollageLayouts`, shared with the web so a collage of the same photos comes
/// out the same shape.
///
/// A caption can be laid over the whole canvas (#1020, stage C): dragged into
/// place, in one of three sizes, in white, black, a colour taken from the
/// photos or any colour from the picker. The rules are in `CollageText`,
/// shared with the web.
///
/// **Teilen** renders the collage on the device and hands the JPEG to the
/// share sheet. Opened from an album, **Sichern** uploads it as an ordinary
/// photo — there is no collage endpoint, so this is the same move the web
/// makes — adds it to that album and tells the album to reload. The collage
/// takes the capture date of its **newest** source plus one second, so it
/// sorts right after the photos it was made from rather than at "now".
///
/// The preview cells crop with the same `CollageLayouts.coverCrop` the render
/// uses and leave the same white seams, so what is on screen is what is saved.
struct CollageView: View {
    /// The photos in the order they were picked; the first fills the first cell.
    let photos: [PhotoWithCuration]
    /// The album the collage was made from; the saved collage joins it. Without
    /// one there is nothing to save into — the web offers sharing only, too.
    let albumId: Int?
    /// Called after the collage is saved, so the album can show it.
    let onSaved: (() -> Void)?

    @Environment(\.dismiss) private var dismiss
    /// The variant being edited; nil while the variants are being chosen.
    @State private var editingLayout: Int?
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
    @State private var isSharing = false
    @State private var sharedFile: SharedFile?
    @State private var statusMessage: String?
    @State private var statusIsError = false
    @State private var didSave = false

    init(photos: [PhotoWithCuration], albumId: Int? = nil, onSaved: (() -> Void)? = nil) {
        self.photos = photos
        self.albumId = albumId
        self.onSaved = onSaved
        _order = State(initialValue: Array(photos.indices))
    }

    private var layouts: [CollageLayouts.Layout] {
        CollageLayouts.layouts(for: photos.count)
    }

    var body: some View {
        NavigationStack {
            Group {
                if layouts.isEmpty {
                    ContentUnavailableView {
                        Label("Keine Collage möglich", systemImage: "square.grid.2x2")
                    } description: {
                        Text("Eine Collage braucht \(CollageLayouts.minPhotos) bis \(CollageLayouts.maxPhotos) Fotos — ausgewählt sind \(photos.count).")
                    }
                } else {
                    layoutPicker
                }
            }
            .navigationTitle("Layout wählen")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Abbrechen") { dismiss() }
                }
            }
            .navigationDestination(item: $editingLayout) { index in
                if layouts.indices.contains(index) {
                    editor(layout: layouts[index])
                }
            }
        }
        .task { await loadPalette() }
        // Dragging a photo downward must move the photo, not pull the sheet
        // away with the arrangement in it.
        .interactiveDismissDisabled()
        .sheet(item: $sharedFile) { file in
            FileActivityView(url: file.url)
        }
    }

    // MARK: - Step 1: choosing a variant

    /// The three variants, each drawn with the photos — the web's first step.
    private var layoutPicker: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("Wähle ein Layout für deine \(photos.count) Fotos.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                LazyVGrid(
                    columns: [GridItem(.adaptive(minimum: 150), spacing: 12, alignment: .top)],
                    spacing: 16
                ) {
                    ForEach(layouts.indices, id: \.self) { index in
                        variantButton(index)
                    }
                }
            }
            .padding()
        }
    }

    private func variantButton(_ index: Int) -> some View {
        let layout = layouts[index]
        return Button {
            // As on the web, a variant starts from the picked order — cells
            // of another variant are not the same cells.
            order = Array(photos.indices)
            swapAnchor = nil
            editingLayout = index
        } label: {
            VStack(spacing: 6) {
                CollageCanvas(layout: layout, photos: photos)
                    .allowsHitTesting(false)
                    .frame(maxWidth: .infinity, maxHeight: 220)
                Text(layout.name)
                    .font(.footnote)
                    .foregroundStyle(.primary)
            }
            .padding(6)
            .background(
                RoundedRectangle(cornerRadius: 10)
                    .strokeBorder(Color.secondary.opacity(0.3))
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Layout \(layout.name)")
    }

    // MARK: - Step 2: editing the chosen variant

    private func editor(layout: CollageLayouts.Layout) -> some View {
        // A plain stack, not a scroll view: a photo dragged inside the canvas
        // must move the photo, not the page.
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

            Text(hint)
                .multilineTextAlignment(.center)
                .font(.caption)
                .foregroundStyle(.secondary)

            textControls

            if let statusMessage {
                Text(statusMessage)
                    .font(.caption)
                    .foregroundStyle(statusIsError ? Color.red : Color.secondary)
                    .multilineTextAlignment(.center)
            }

            Spacer(minLength: 0)
        }
        .padding()
        .navigationTitle("Collage bearbeiten")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                if isSharing {
                    ProgressView()
                } else {
                    Button {
                        Task { await share(layout: layout) }
                    } label: {
                        Label("Teilen", systemImage: "square.and.arrow.up")
                    }
                    .disabled(isSaving)
                }
                if albumId != nil && !didSave {
                    if isSaving {
                        ProgressView()
                    } else {
                        Button("Sichern") { Task { await save(layout: layout) } }
                            .disabled(isSharing)
                    }
                } else {
                    Button("Fertig") { dismiss() }
                }
            }
        }
    }

    private var hint: String {
        if swapAnchor != nil {
            return "Tippe das Feld an, mit dem getauscht werden soll."
        }
        let swap = "Zum Tauschen ein Foto auf ein anderes ziehen – oder zwei nacheinander antippen."
        return overlays.isEmpty
            ? swap
            : swap + " Text ziehen zum Verschieben, antippen zum Bearbeiten."
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
                TextField("Text über die Collage …", text: Binding(
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

                HStack(spacing: 8) {
                    // Any colour at all, as the web's colour picker offers;
                    // the swatches beside it are the quick choices.
                    ColorPicker("Farbe", selection: Binding(
                        get: { Color(uiColor: CollageText.color(fromHex: overlays[index].colorHex) ?? .white) },
                        set: { overlays[index].colorHex = CollageText.hex(from: UIColor($0)) }
                    ), supportsOpacity: false)
                    .labelsHidden()

                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(palette, id: \.self) { hex in
                                swatch(hex, index: index)
                            }
                        }
                        .padding(.vertical, 2)
                    }
                }

                HStack {
                    Button("Text entfernen", role: .destructive) {
                        overlays.remove(at: index)
                        editing = nil
                    }
                    Spacer()
                    Button("Fertig") { editing = nil }
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
        .accessibilityLabel("Farbe \(hex)")
    }

    private func move(_ id: CollageText.Overlay.ID, dx: Double, dy: Double) {
        guard let index = overlays.firstIndex(where: { $0.id == id }) else { return }
        overlays[index] = CollageText.moved(overlays[index], byX: dx, y: dy)
    }

    /// Read the colours out of the photos so the caption can be tinted with
    /// one of them — all of them, as the web samples every photo it loaded.
    ///
    /// The images come from the same cache the preview tiles fill, so this is
    /// usually free; `dominantColors` shrinks each to 64 × 64 before looking.
    @MainActor
    private func loadPalette() async {
        var images: [UIImage] = []
        await TransformedPhotosIndex.shared.load()
        for photo in photos {
            if let image = await fullImage(of: photo) {
                images.append(image)
            }
        }
        guard !images.isEmpty else { return }
        palette = CollageText.palette(from: images)
    }

    /// The photo at full size, rendered through its recipe when it has one —
    /// the image the preview tile shows and the render draws.
    @MainActor
    private func fullImage(of photo: PhotoWithCuration) async -> UIImage? {
        let source = TransformedPhotosIndex.shared.request(
            photoId: photo.id, filename: photo.filename
        )
        if let cached = await ImageCache.shared.image(forKey: source.cacheKey) {
            return cached
        }
        guard let data = try? await APIClient.shared.downloadData(
            source.path, query: source.query.isEmpty ? nil : source.query
        ) else { return nil }
        return UIImage(data: data)
    }

    // MARK: - Rendering, sharing, saving

    /// Render the collage at full size as a JPEG.
    ///
    /// A photo that cannot be fetched costs its cell, not the collage.
    @MainActor
    private func renderJPEG(layout: CollageLayouts.Layout) async -> Data? {
        var tiles: [CollageRenderer.Tile] = []
        await TransformedPhotosIndex.shared.load()
        for index in order {
            let photo = photos[index]
            guard let image = await fullImage(of: photo) else { continue }
            // A recipe-rendered photo is already framed by its owner; the AI's
            // focal point belongs to the original frame and would re-shift it.
            let focal = TransformedPhotosIndex.shared.hasRecipe(photo.id)
                ? nil
                : photo.auto_crop.map { CGPoint(x: $0.x, y: $0.y) }
            tiles.append(CollageRenderer.Tile(image: image, focal: focal))
        }
        guard !tiles.isEmpty else { return nil }
        let rendered = CollageRenderer.render(layout: layout, tiles: tiles, overlays: overlays)
        return rendered?.jpegData(compressionQuality: CollageRenderer.jpegQuality)
    }

    private func report(_ message: String, isError: Bool) {
        statusMessage = message
        statusIsError = isError
    }

    /// Hand the rendered JPEG to the share sheet — the web's "Teilen".
    @MainActor
    private func share(layout: CollageLayouts.Layout) async {
        isSharing = true
        statusMessage = nil
        defer { isSharing = false }
        guard let jpeg = await renderJPEG(layout: layout) else {
            report("Die Collage konnte nicht erzeugt werden.", isError: true)
            return
        }
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent(CollageRenderer.filename())
        do {
            try jpeg.write(to: url, options: .atomic)
            sharedFile = SharedFile(url: url)
        } catch {
            report(error.localizedDescription, isError: true)
        }
    }

    /// Upload the collage as a new photo and add it to the album.
    @MainActor
    private func save(layout: CollageLayouts.Layout) async {
        guard let albumId else { return }
        isSaving = true
        statusMessage = nil
        defer { isSaving = false }

        guard let jpeg = await renderJPEG(layout: layout) else {
            report("Die Collage konnte nicht erzeugt werden.", isError: true)
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
        let uploaded: APIClient.UploadResult
        do {
            uploaded = try await APIClient.shared.uploadPhoto(
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
        } catch {
            report(error.localizedDescription, isError: true)
            return
        }

        // Saved either way from here on; a failed album add must not offer
        // "Sichern" again, which would upload the same collage twice.
        didSave = true
        struct Body: Encodable { let albumId: Int; let photoId: Int }
        struct Resp: Decodable { let success: Bool }
        do {
            let _: Resp = try await APIClient.shared.post(
                "/albums/photos",
                body: Body(albumId: albumId, photoId: uploaded.photoId)
            )
            report("Collage wurde im Album gespeichert.", isError: false)
        } catch {
            report(
                "Collage gesichert, aber nicht zum Album hinzugefügt: \(error.localizedDescription)",
                isError: true
            )
        }
        onSaved?()
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

// MARK: - Opening a collage from a grid

extension View {
    /// The collage sheet for a grid's selection, plus the bookkeeping that
    /// remembers in which order the photos were picked.
    ///
    /// One modifier rather than two in every grid: the grids' bodies are
    /// already long chains, and two more links pushed one of them past what
    /// the type checker solves in reasonable time.
    func collageSheet(
        isPresented: Binding<Bool>,
        selectedIds: Set<Int>,
        order: Binding<[Int]>,
        photos: [PhotoWithCuration],
        albumId: Int? = nil,
        onSaved: (() -> Void)? = nil
    ) -> some View {
        modifier(CollageSheetModifier(
            isPresented: isPresented,
            selectedIds: selectedIds,
            order: order,
            photos: photos,
            albumId: albumId,
            onSaved: onSaved
        ))
    }
}

/// "Collage" in a grid's selection toolbar — enabled for two to nine photos,
/// the range there are layouts for.
struct CollageToolbarButton: View {
    let selectedCount: Int
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Label("Collage", systemImage: "square.grid.2x2")
        }
        .disabled(!CollageLayouts.canCollage(selectedCount))
    }
}

private struct CollageSheetModifier: ViewModifier {
    @Binding var isPresented: Bool
    let selectedIds: Set<Int>
    @Binding var order: [Int]
    let photos: [PhotoWithCuration]
    let albumId: Int?
    let onSaved: (() -> Void)?

    func body(content: Content) -> some View {
        content
            .sheet(isPresented: $isPresented) {
                CollageView(
                    photos: SelectionOrder.photos(photos, in: order),
                    albumId: albumId,
                    onSaved: onSaved
                )
            }
            .onChange(of: selectedIds) { _, ids in
                order = SelectionOrder.reconciled(order, with: ids, gridOrder: photos.map(\.id))
            }
    }
}

/// A rendered collage on disk, waiting for the share sheet.
private struct SharedFile: Identifiable {
    let url: URL
    var id: URL { url }
}

/// The collage itself: the canvas at its layout's aspect, each cell filled
/// with its photo.
///
/// Without callbacks it is a picture and nothing more — the variant previews.
private struct CollageCanvas: View {
    let layout: CollageLayouts.Layout
    let photos: [PhotoWithCuration]
    var highlighted: Int? = nil
    var overlays: [CollageText.Overlay] = []
    var editingOverlay: CollageText.Overlay.ID? = nil
    var onTapCell: (Int) -> Void = { _ in }
    var onSwapCells: (Int, Int) -> Void = { _, _ in }
    var onSelectOverlay: (CollageText.Overlay.ID?) -> Void = { _ in }
    var onMoveOverlay: (CollageText.Overlay.ID, Double, Double) -> Void = { _, _, _ in }

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
                // The seams between the photos are white in the saved
                // collage, so they are white here too, in either theme.
                Color.white
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
        // The render's white seam, scaled to the preview: the same fraction of
        // the long edge, half of it on every side of the cell.
        let gap = CGFloat(CollageRenderer.gapFraction) * max(canvas.width, canvas.height)
        let width: CGFloat = max(0, CGFloat(cell.width) * canvas.width - gap)
        let height: CGFloat = max(0, CGFloat(cell.height) * canvas.height - gap)
        let isDropTarget = photoDragOver == index && photoDragFrom != index
        return CollageTile(photo: photo)
            .frame(width: width, height: height)
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
            .offset(x: CGFloat(cell.x) * canvas.width + gap / 2, y: CGFloat(cell.y) * canvas.height + gap / 2)
    }
}

/// One photo in its preview cell, cropped exactly as the render will crop it.
///
/// `PhotoThumbnailView` centres its focal point inside a *square*; a cell of
/// another shape then showed a different part of the photo than the saved
/// collage. This tile runs the render's own `CollageLayouts.coverCrop` against
/// the cell's real aspect instead. It loads the same full image the render
/// fetches, so the cache usually makes saving cheaper, not the preview dearer.
private struct CollageTile: View {
    @State private var loader: ThumbnailLoader
    private let autoCrop: AutoCrop?

    init(photo: PhotoWithCuration) {
        _loader = State(initialValue: ThumbnailLoader(filename: photo.filename, photoId: photo.id))
        autoCrop = photo.auto_crop
    }

    var body: some View {
        GeometryReader { geo in
            if let image = loader.image, geo.size.width > 0, geo.size.height > 0 {
                cropped(image, in: geo.size)
            } else {
                Rectangle()
                    .fill(.quaternary)
                    .overlay {
                        if loader.isLoading {
                            ProgressView()
                        } else if loader.hasError {
                            Image(systemName: "exclamationmark.triangle")
                                .foregroundStyle(.red.opacity(0.6))
                        }
                    }
            }
        }
        .clipped()
        .task { await loader.load() }
    }

    private func cropped(_ image: UIImage, in size: CGSize) -> some View {
        // The render drops the AI focal point on a photo the user framed
        // themselves; so does the preview.
        let focal = loader.isRecipeRendered ? nil : autoCrop.map { CGPoint(x: $0.x, y: $0.y) }
        let source = CollageLayouts.coverCrop(
            photoWidth: Double(image.size.width),
            photoHeight: Double(image.size.height),
            destinationAspect: Double(size.width / size.height),
            focal: focal
        )
        let scale = source.width > 0 ? Double(size.width) / source.width : 1
        return Image(uiImage: image)
            .resizable()
            .frame(
                width: CGFloat(Double(image.size.width) * scale),
                height: CGFloat(Double(image.size.height) * scale)
            )
            .offset(x: CGFloat(-source.x * scale), y: CGFloat(-source.y * scale))
            .frame(width: size.width, height: size.height, alignment: .topLeading)
    }
}

/// One caption on the preview.
///
/// The font size is a fraction of the *preview's* height, the same fraction
/// the render applies to the 4000 px canvas, so the caption covers the same
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

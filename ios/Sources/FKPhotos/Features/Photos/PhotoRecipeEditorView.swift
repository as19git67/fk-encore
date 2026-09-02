import CoreImage
import CoreImage.CIFilterBuiltins
import SwiftUI
import UIKit

/// Editing a photo by hand: drag the crop, turn it, and pull the tone around
/// with a live preview (#1019, stage B).
///
/// Stage A could only confirm what the AI or someone else had already worked
/// out. This is the half where the user decides. Nothing is destructive — the
/// recipe is saved per user with `PUT /photos/:id/transforms` and the original
/// file is never touched, so „zurücksetzen" always has something to go back to.
///
/// The preview is computed on the phone (`PhotoRecipe.toneCurve`) rather than
/// asked for: a round-trip per slider tick is unusable, and the curve is the
/// renderer's own, so what is on screen is what the server will produce.
@Observable
@MainActor
final class PhotoRecipeEditorViewModel {
    let photoId: Int

    /// What is being edited. Every change re-derives the preview.
    var recipe: PhotoRecipe.Recipe {
        didSet { if recipe != oldValue { schedulePreview() } }
    }

    /// The locked aspect, or nil for a freehand crop.
    var ratio: PhotoTransforms.AspectRatio?

    private(set) var original: UIImage?
    private(set) var preview: UIImage?
    private(set) var isLoading = false
    private(set) var isSaving = false
    private(set) var isLevelling = false
    var errorMessage: String?

    /// True once something has been changed but not yet saved.
    private(set) var isDirty = false

    private var saved: PhotoRecipe.Recipe
    private var previewTask: Task<Void, Never>?
    private let context = CIContext(options: [.useSoftwareRenderer: false])

    init(photoId: Int, existing: PhotoTransforms.Row?) {
        self.photoId = photoId
        let start = existing.map(PhotoRecipe.Recipe.init) ?? .neutral
        self.recipe = start
        self.saved = start
    }

    // MARK: - Loading

    /// The longest edge the editor works at.
    ///
    /// The full file can be 50 megapixels and every slider tick would wait on
    /// a filter pass over all of it. The crop is normalized and the tone curve
    /// is per pixel, so a downscaled copy edits exactly the same — and the
    /// saved recipe is applied to the original server-side either way.
    static let editingMaxEdge: CGFloat = 1600

    /// Fetch the photo and shrink it to a size worth previewing.
    ///
    /// `v=original` redirects to the plain file, so the width parameter has no
    /// effect there — the shrinking happens here rather than being asked for.
    func load() async {
        guard original == nil else { return }
        isLoading = true
        errorMessage = nil
        do {
            let data = try await APIClient.shared.downloadData(
                PhotoTransforms.renderPath(photoId: photoId),
                query: PhotoTransforms.renderQuery(.original)
            )
            if let image = UIImage(data: data) {
                original = Self.downscaled(image, maxEdge: Self.editingMaxEdge)
                if let crop = recipe.crop {
                    // The ratio is of the image's own pixels, so it is read
                    // off the full-size photo, not the shrunk copy — the two
                    // agree, but only because the shrink keeps the shape.
                    ratio = PhotoRecipe.guessRatio(
                        of: crop,
                        imageWidth: Double(image.size.width),
                        imageHeight: Double(image.size.height)
                    )
                }
                schedulePreview()
            } else {
                errorMessage = "Das Foto konnte nicht geladen werden."
            }
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }

    // MARK: - Editing

    /// Switch the locked ratio, re-framing the crop to match.
    ///
    /// The AI's crop for that ratio is preferred over a centred one — it is
    /// the same starting point the one-tap action would have used, so picking
    /// a ratio by hand does not throw away what the AI worked out.
    func select(ratio newRatio: PhotoTransforms.AspectRatio?, suggestion: PhotoTransforms.Suggestion?) {
        ratio = newRatio
        guard let newRatio, let original else { return }
        markDirty()
        if let suggested = suggestion?.crops[newRatio.rawValue] {
            recipe.crop = suggested
            return
        }
        recipe.crop = PhotoRecipe.centredCrop(
            ratio: newRatio,
            imageWidth: Double(original.size.width),
            imageHeight: Double(original.size.height)
        )
    }

    /// Drop the crop entirely — back to the whole frame.
    func clearCrop() {
        markDirty()
        ratio = nil
        recipe.crop = nil
    }

    func rotate() {
        markDirty()
        recipe.rotation = PhotoRecipe.rotatedClockwise(recipe.rotation)
    }

    func update(crop: PhotoTransforms.Crop) {
        markDirty()
        recipe.crop = crop
    }

    func markDirty() {
        isDirty = true
    }

    /// Ask the server what the tone should be, and fill the sliders in.
    ///
    /// It reads the pixels inside the current crop, so levelling after
    /// cropping the sky out gives a different — better — answer than before.
    /// It does not persist: the values land in the sliders and the user saves,
    /// or does not.
    func autoLevels() async {
        isLevelling = true
        errorMessage = nil
        do {
            let result: PhotoRecipe.AutoLevelsResult = try await APIClient.shared.post(
                "/photos/\(photoId)/transforms/auto-levels",
                body: PhotoRecipe.AutoLevelsRequest(crop: recipe.crop)
            )
            recipe = PhotoRecipe.applying(result, to: recipe)
            markDirty()
        } catch {
            errorMessage = error.localizedDescription
        }
        isLevelling = false
    }

    /// Save the recipe. Returns true when it landed, so the caller can close.
    func save() async -> Bool {
        isSaving = true
        errorMessage = nil
        defer { isSaving = false }
        do {
            let row: PhotoTransforms.Row = try await APIClient.shared.put(
                "/photos/\(photoId)/transforms",
                body: PhotoRecipe.UpsertRequest(recipe)
            )
            // Adopt what the server stored rather than what was sent: it
            // clamps too, and the next edit should start from the truth.
            recipe = PhotoRecipe.Recipe(row)
            saved = recipe
            isDirty = false
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    /// Back to the last saved state, without touching the server.
    func revert() {
        recipe = saved
        isDirty = false
    }

    // MARK: - Preview

    /// Re-derive the preview, cancelling any pass still running.
    ///
    /// A slider drag fires many times a second; without the cancel, every
    /// intermediate value would be rendered and the last one would arrive
    /// last-but-one.
    private func schedulePreview() {
        previewTask?.cancel()
        guard let original else { return }
        let curve = PhotoRecipe.toneCurve(for: recipe)
        guard !curve.isIdentity else {
            preview = nil
            return
        }
        let context = self.context
        previewTask = Task { [weak self] in
            let rendered = await Task.detached(priority: .userInitiated) {
                PhotoRecipeEditorViewModel.applyTone(curve, to: original, context: context)
            }.value
            guard !Task.isCancelled else { return }
            self?.preview = rendered
        }
    }

    /// The image the preview shows: the toned version when there is one, the
    /// original otherwise. Never nil once loading finished.
    var displayed: UIImage? { preview ?? original }

    /// Shrink an image so its longest edge fits, keeping its shape. Images
    /// already small enough are returned untouched.
    nonisolated static func downscaled(_ image: UIImage, maxEdge: CGFloat) -> UIImage {
        let longest = max(image.size.width, image.size.height)
        guard longest > maxEdge, longest > 0 else { return image }
        let scale = maxEdge / longest
        let size = CGSize(
            width: (image.size.width * scale).rounded(),
            height: (image.size.height * scale).rounded()
        )
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        return UIGraphicsImageRenderer(size: size, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: size))
        }
    }

    /// The tone curve as Core Image filters.
    ///
    /// The two linear steps collapse into a single colour matrix — a slope and
    /// an offset — and gamma follows as the exponent, in the renderer's order.
    /// An approximation in one respect: Core Image works in its own colour
    /// space, so the preview is close rather than pixel-identical to the JPEG
    /// the server later encodes.
    nonisolated static func applyTone(
        _ curve: PhotoRecipe.ToneCurve,
        to image: UIImage,
        context: CIContext
    ) -> UIImage? {
        guard let input = CIImage(image: image) else { return nil }

        let slope = curve.slope * curve.levelsSlope
        let intercept = curve.intercept * curve.levelsSlope + curve.levelsIntercept

        var output = input
        if abs(slope - 1) > 0.001 || abs(intercept) > 0.001 {
            let matrix = CIFilter.colorMatrix()
            matrix.inputImage = output
            matrix.rVector = CIVector(x: CGFloat(slope), y: 0, z: 0, w: 0)
            matrix.gVector = CIVector(x: 0, y: CGFloat(slope), z: 0, w: 0)
            matrix.bVector = CIVector(x: 0, y: 0, z: CGFloat(slope), w: 0)
            matrix.aVector = CIVector(x: 0, y: 0, z: 0, w: 1)
            matrix.biasVector = CIVector(
                x: CGFloat(intercept), y: CGFloat(intercept), z: CGFloat(intercept), w: 0
            )
            output = matrix.outputImage ?? output
        }
        if abs(curve.exponent - 1) > 0.001 {
            let gamma = CIFilter.gammaAdjust()
            gamma.inputImage = output
            gamma.power = Float(curve.exponent)
            output = gamma.outputImage ?? output
        }

        guard let cgImage = context.createCGImage(output, from: input.extent) else {
            return nil
        }
        return UIImage(cgImage: cgImage, scale: image.scale, orientation: .up)
    }
}

// MARK: - View

struct PhotoRecipeEditorView: View {
    @State private var viewModel: PhotoRecipeEditorViewModel
    /// The AI's crops, so picking a ratio by hand starts from its framing.
    let suggestion: PhotoTransforms.Suggestion?
    /// The ratio to open on, when the editor was entered through a preset
    /// rather than through „selbst bearbeiten". Nil leaves the crop as saved.
    let startRatio: PhotoTransforms.AspectRatio?
    /// Called after a successful save, so the caller can reload its bundle.
    var onSaved: () -> Void = {}

    @Environment(\.dismiss) private var dismiss
    /// Guards the one-off ratio preselection: `.task` can run again for the
    /// same editor, and re-selecting would throw away a crop already dragged.
    @State private var appliedStartRatio = false

    @MainActor
    init(
        photoId: Int,
        existing: PhotoTransforms.Row?,
        suggestion: PhotoTransforms.Suggestion?,
        startRatio: PhotoTransforms.AspectRatio? = nil,
        onSaved: @escaping () -> Void = {}
    ) {
        _viewModel = State(
            initialValue: PhotoRecipeEditorViewModel(photoId: photoId, existing: existing)
        )
        self.suggestion = suggestion
        self.startRatio = startRatio
        self.onSaved = onSaved
    }

    var body: some View {
        NavigationStack {
            Group {
                if viewModel.isLoading && viewModel.original == nil {
                    ProgressView("Foto laden…")
                } else if let image = viewModel.displayed {
                    editor(image: image)
                } else {
                    ContentUnavailableView(
                        "Foto nicht verfügbar",
                        systemImage: "photo",
                        description: Text(viewModel.errorMessage ?? "Das Foto konnte nicht geladen werden.")
                    )
                }
            }
            .navigationTitle("Bearbeiten")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Abbrechen") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if viewModel.isSaving {
                        ProgressView()
                    } else {
                        Button("Sichern") {
                            Task {
                                if await viewModel.save() {
                                    onSaved()
                                    dismiss()
                                }
                            }
                        }
                        .disabled(!viewModel.isDirty)
                    }
                }
            }
            .task {
                await viewModel.load()
                // A preset opened this editor: frame the crop to it, using the
                // AI's composition for that ratio when there is one. Same
                // starting point the one-tap action would have used.
                if let startRatio, !appliedStartRatio, viewModel.original != nil {
                    appliedStartRatio = true
                    viewModel.select(ratio: startRatio, suggestion: suggestion)
                }
            }
        }
    }

    private func editor(image: UIImage) -> some View {
        VStack(spacing: 0) {
            CropCanvas(
                image: image,
                crop: viewModel.recipe.crop,
                rotation: viewModel.recipe.rotation,
                ratio: viewModel.ratio,
                onChange: { viewModel.update(crop: $0) }
            )
            .frame(maxWidth: .infinity)
            .layoutPriority(1)
            .background(Color.black)

            controls
                .frame(maxHeight: 320)
        }
    }

    private var controls: some View {
        Form {
            if let error = viewModel.errorMessage {
                Section {
                    Text(error).foregroundStyle(.red).font(.callout)
                }
            }

            Section("Zuschnitt") {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ratioChip(nil, label: "Frei")
                        ForEach(PhotoTransforms.AspectRatio.allCases) { candidate in
                            ratioChip(candidate, label: candidate.rawValue)
                        }
                    }
                    .padding(.vertical, 2)
                }
                HStack {
                    Button {
                        viewModel.rotate()
                    } label: {
                        Label("Drehen", systemImage: "rotate.right")
                    }
                    Spacer()
                    if viewModel.recipe.crop != nil {
                        Button("Ganzes Bild") { viewModel.clearCrop() }
                    }
                }
                .buttonStyle(.borderless)
            }

            Section {
                slider(
                    "Belichtung",
                    value: Binding(
                        get: { viewModel.recipe.exposure },
                        set: { viewModel.recipe.exposure = $0; viewModel.markDirty() }
                    ),
                    range: PhotoRecipe.Limits.exposureSlider,
                    step: 0.05,
                    format: { String(format: "%+.2f EV", $0) }
                )
                slider(
                    "Kontrast",
                    value: Binding(
                        get: { viewModel.recipe.contrast },
                        set: { viewModel.recipe.contrast = $0; viewModel.markDirty() }
                    ),
                    range: PhotoRecipe.Limits.contrastSlider,
                    step: 0.05,
                    format: { String(format: "%+.0f %%", $0 * 100) }
                )
                slider(
                    "Gamma",
                    value: Binding(
                        get: { viewModel.recipe.gamma },
                        set: { viewModel.recipe.gamma = $0; viewModel.markDirty() }
                    ),
                    range: PhotoRecipe.Limits.gammaSlider,
                    step: 0.05,
                    format: { String(format: "%.2f", $0) }
                )

                Button {
                    Task { await viewModel.autoLevels() }
                } label: {
                    if viewModel.isLevelling {
                        ProgressView()
                    } else {
                        Label("Auto-Levels", systemImage: "wand.and.stars")
                    }
                }
                .disabled(viewModel.isLevelling)
            } header: {
                Text("Belichtung")
            } footer: {
                Text("Auto-Levels misst die Pixel innerhalb des Zuschnitts und füllt nur die Regler — gespeichert wird erst mit „Sichern\".")
            }
        }
    }

    private func ratioChip(_ candidate: PhotoTransforms.AspectRatio?, label: String) -> some View {
        let selected = viewModel.ratio == candidate
        return Button {
            viewModel.select(ratio: candidate, suggestion: suggestion)
        } label: {
            Text(label)
                .font(.caption.weight(selected ? .bold : .regular))
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(
                    selected ? Color.accentColor.opacity(0.2) : Color.secondary.opacity(0.12),
                    in: Capsule()
                )
        }
        .buttonStyle(.plain)
    }

    private func slider(
        _ title: String,
        value: Binding<Double>,
        range: ClosedRange<Double>,
        step: Double,
        format: @escaping (Double) -> String
    ) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(title).font(.caption)
                Spacer()
                Text(format(value.wrappedValue))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            Slider(value: value, in: range, step: step)
        }
    }
}

/// The photo with its crop rectangle on top: everything outside is dimmed, the
/// frame is dragged to move it, and the four corners resize it.
private struct CropCanvas: View {
    let image: UIImage
    let crop: PhotoTransforms.Crop?
    let rotation: Int
    let ratio: PhotoTransforms.AspectRatio?
    let onChange: (PhotoTransforms.Crop) -> Void

    /// Where the crop was when the current drag started, so a gesture is
    /// applied to a fixed base instead of compounding its own output.
    @State private var dragStart: PhotoTransforms.Crop?

    private var current: PhotoTransforms.Crop {
        crop ?? PhotoTransforms.Crop(x: 0, y: 0, w: 1, h: 1)
    }

    var body: some View {
        GeometryReader { geo in
            let frame = fittedFrame(in: geo.size)
            ZStack(alignment: .topLeading) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(width: frame.width, height: frame.height)
                    .overlay { cropOverlay(in: frame.size) }
                    .position(x: geo.size.width / 2, y: geo.size.height / 2)
            }
            // The recipe's rotation is applied after the crop server-side, so
            // it turns the whole canvas rather than moving the rectangle.
            .rotationEffect(.degrees(Double(rotation)))
            .animation(.easeInOut(duration: 0.2), value: rotation)
        }
    }

    /// The image drawn to fit, in points.
    private func fittedFrame(in size: CGSize) -> CGRect {
        let imageAspect = image.size.width / max(image.size.height, 1)
        let boxAspect = size.width / max(size.height, 1)
        let width = imageAspect >= boxAspect ? size.width : size.height * imageAspect
        let height = imageAspect >= boxAspect ? size.width / imageAspect : size.height
        return CGRect(x: 0, y: 0, width: width, height: height)
    }

    @ViewBuilder
    private func cropOverlay(in size: CGSize) -> some View {
        let rect = CGRect(
            x: current.x * size.width,
            y: current.y * size.height,
            width: current.w * size.width,
            height: current.h * size.height
        )
        ZStack(alignment: .topLeading) {
            // Everything outside the crop, dimmed.
            Color.black.opacity(0.45)
                .reverseMask {
                    Rectangle().frame(width: rect.width, height: rect.height)
                        .offset(x: rect.minX, y: rect.minY)
                }

            Rectangle()
                .strokeBorder(Color.white, lineWidth: 1)
                .frame(width: rect.width, height: rect.height)
                .offset(x: rect.minX, y: rect.minY)
                .contentShape(Rectangle())
                .gesture(moveGesture(in: size))

            ForEach(PhotoRecipe.Corner.allCases, id: \.self) { corner in
                handle(corner, rect: rect, size: size)
            }
        }
        .allowsHitTesting(true)
    }

    private func handle(
        _ corner: PhotoRecipe.Corner, rect: CGRect, size: CGSize
    ) -> some View {
        Circle()
            .fill(Color.white)
            .frame(width: 22, height: 22)
            .position(
                x: corner.movesLeftEdge ? rect.minX : rect.maxX,
                y: corner.movesTopEdge ? rect.minY : rect.maxY
            )
            .gesture(resizeGesture(corner, in: size))
    }

    private func moveGesture(in size: CGSize) -> some Gesture {
        DragGesture()
            .onChanged { value in
                let base = dragStart ?? current
                if dragStart == nil { dragStart = current }
                onChange(PhotoRecipe.moved(
                    base,
                    byX: Double(value.translation.width / max(size.width, 1)),
                    y: Double(value.translation.height / max(size.height, 1))
                ))
            }
            .onEnded { _ in dragStart = nil }
    }

    private func resizeGesture(_ corner: PhotoRecipe.Corner, in size: CGSize) -> some Gesture {
        DragGesture()
            .onChanged { value in
                let base = dragStart ?? current
                if dragStart == nil { dragStart = current }
                onChange(PhotoRecipe.resized(
                    base,
                    corner: corner,
                    byX: Double(value.translation.width / max(size.width, 1)),
                    y: Double(value.translation.height / max(size.height, 1)),
                    ratio: ratio,
                    imageWidth: Double(image.size.width),
                    imageHeight: Double(image.size.height)
                ))
            }
            .onEnded { _ in dragStart = nil }
    }
}

private extension View {
    /// Punch a hole in a view — the dimming outside the crop.
    func reverseMask<Mask: View>(@ViewBuilder _ mask: () -> Mask) -> some View {
        self.mask {
            ZStack(alignment: .topLeading) {
                Rectangle()
                mask().blendMode(.destinationOut)
            }
            .compositingGroup()
        }
    }
}

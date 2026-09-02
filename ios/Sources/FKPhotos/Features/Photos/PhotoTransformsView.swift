import SwiftUI
import UIKit

/// Reviewing a photo's non-destructive edits: what the AI proposes, what other
/// people in the household saved, and what this user has applied.
///
/// The web's `PhotoTransformEditor` in its review half (#1019, stage A):
/// everything here is a confirmation of something the server already computed
/// — apply a suggested crop at one ratio, adopt someone else's recipe, or go
/// back to the original. Making an edit by hand is `PhotoRecipeEditorView`
/// (stage B), reachable from „Selbst bearbeiten…".
@Observable
final class PhotoTransformsViewModel {
    let photoId: Int

    private(set) var bundle: PhotoTransforms.Bundle?
    private(set) var isLoading = false
    private(set) var isSaving = false
    var errorMessage: String?

    /// The ratio whose preview is on screen. Starts on the first one the AI
    /// composed, since that is the one most likely to be wanted.
    var previewRatio: PhotoTransforms.AspectRatio?

    init(photoId: Int) {
        self.photoId = photoId
    }

    var suggestedRatios: [PhotoTransforms.AspectRatio] {
        PhotoTransforms.suggestedRatios(in: bundle)
    }

    var adoptable: [PhotoTransforms.Other] {
        PhotoTransforms.adoptable(in: bundle)
    }

    var hasOwnRecipe: Bool { PhotoTransforms.hasOwnRecipe(bundle) }

    @MainActor
    func load() async {
        isLoading = true
        errorMessage = nil
        do {
            let bundle: PhotoTransforms.Bundle = try await APIClient.shared.get(
                "/photos/\(photoId)/transforms"
            )
            self.bundle = bundle
            if previewRatio == nil {
                previewRatio = PhotoTransforms.suggestedRatios(in: bundle).first
            }
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }

    /// Materialize the AI's crop at one ratio as this user's recipe.
    @MainActor
    func apply(ratio: PhotoTransforms.AspectRatio) async {
        await mutate {
            let _: PhotoTransforms.Row = try await APIClient.shared.post(
                "/photos/\(self.photoId)/transforms/from-suggestion",
                body: PhotoTransforms.FromSuggestionRequest(ratio: ratio.rawValue)
            )
        }
    }

    /// Copy someone else's recipe.
    @MainActor
    func adopt(_ other: PhotoTransforms.Other) async {
        await mutate {
            let _: PhotoTransforms.Row = try await APIClient.shared.post(
                "/photos/\(self.photoId)/transforms/adopt",
                body: PhotoTransforms.AdoptRequest(from_transform_id: other.id)
            )
        }
    }

    /// Back to the original.
    @MainActor
    func reset() async {
        await mutate {
            // The route answers `{ deleted: … }`, not the app-wide
            // `DeleteResponse` shape.
            let _: PhotoTransforms.DeleteResult = try await APIClient.shared.delete(
                "/photos/\(self.photoId)/transforms"
            )
        }
    }

    /// Run a change and re-read the bundle, so what is on screen is what the
    /// server now holds rather than a guess at it.
    ///
    /// The shared index is told about the change as well: every grid in the
    /// app decides from it whether to load the original or the rendered
    /// version, and the bump to that photo's revision is what keeps the
    /// disk cache from handing back the pixels from before the edit.
    @MainActor
    private func mutate(_ work: () async throws -> Void) async {
        isSaving = true
        errorMessage = nil
        do {
            try await work()
            isSaving = false
            await load()
            TransformedPhotosIndex.shared.mark(photoId: photoId, hasRecipe: hasOwnRecipe)
        } catch {
            errorMessage = error.localizedDescription
            isSaving = false
        }
    }
}

struct PhotoTransformsView: View {
    @State private var viewModel: PhotoTransformsViewModel
    @State private var editorTarget: EditorTarget?
    @Environment(AuthManager.self) private var authManager
    @Environment(\.dismiss) private var dismiss

    /// Which ratio the hand editor should open on. A wrapper because
    /// `sheet(item:)` needs an `Identifiable`, and because „frei" is a real
    /// choice rather than the absence of one.
    private struct EditorTarget: Identifiable {
        let ratio: PhotoTransforms.AspectRatio?
        var id: String { ratio?.rawValue ?? "frei" }
    }

    init(photoId: Int) {
        _viewModel = State(initialValue: PhotoTransformsViewModel(photoId: photoId))
    }

    var body: some View {
        NavigationStack {
            Group {
                if viewModel.isLoading && viewModel.bundle == nil {
                    ProgressView("Bearbeitungen laden…")
                } else {
                    content
                }
            }
            .navigationTitle("Zuschnitt")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Fertig") { dismiss() }
                }
            }
            .task { await viewModel.load() }
            .sheet(item: $editorTarget) { target in
                PhotoRecipeEditorView(
                    photoId: viewModel.photoId,
                    existing: viewModel.bundle?.mine,
                    suggestion: viewModel.bundle?.suggestion,
                    startRatio: target.ratio,
                    onSaved: { Task { await viewModel.load() } }
                )
            }
        }
    }

    private var content: some View {
        List {
            if let error = viewModel.errorMessage {
                Section {
                    Text(error)
                        .foregroundStyle(.red)
                        .font(.callout)
                }
            }

            previewSection
            cropSection
            suggestionSection
            adoptSection

            if viewModel.hasOwnRecipe {
                Section {
                    Button(role: .destructive) {
                        Task { await viewModel.reset() }
                    } label: {
                        Label("Auf Original zurücksetzen", systemImage: "arrow.uturn.backward")
                    }
                    .disabled(viewModel.isSaving)
                } footer: {
                    Text("Das Original wird nie verändert — Zurücksetzen entfernt nur deine Bearbeitung.")
                }
            }
        }
    }

    // MARK: - Preview

    @ViewBuilder
    private var previewSection: some View {
        Section {
            TransformedPhotoView(
                photoId: viewModel.photoId,
                variant: previewVariant
            )
            .frame(maxWidth: .infinity)
            .frame(height: 240)
        } header: {
            Text(previewTitle)
        } footer: {
            if let mine = viewModel.bundle?.mine {
                Text("Deine Bearbeitung: \(PhotoTransforms.summary(of: mine))")
            }
        }
    }

    /// The preview shows the ratio being considered, and otherwise whatever
    /// the photo actually renders as.
    private var previewVariant: PhotoTransforms.Variant {
        if let ratio = viewModel.previewRatio, !viewModel.hasOwnRecipe {
            return .suggested(ratio)
        }
        return PhotoTransforms.displayVariant(
            for: viewModel.bundle,
            userId: authManager.currentUser?.id
        )
    }

    private var previewTitle: String {
        if viewModel.hasOwnRecipe { return "Deine Fassung" }
        if viewModel.previewRatio != nil { return "Vorschlag" }
        return "Original"
    }

    // MARK: - Cropping

    /// The ratios, where the user looks for them.
    ///
    /// These used to live one level down, inside the hand editor, and the only
    /// ratios this screen offered were the ones the AI had composed a crop for
    /// — so a photo with no detected face showed no ratios at all and read as
    /// „the feature is missing". The full set is always offered now; a ratio
    /// the AI did compose for still starts from its framing, because
    /// `select(ratio:suggestion:)` prefers the suggested crop over a centred
    /// one.
    private var cropSection: some View {
        Section {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(PhotoTransforms.AspectRatio.allCases) { ratio in
                        ratioChip(ratio)
                    }
                }
                .padding(.vertical, 2)
            }
            Button {
                editorTarget = EditorTarget(ratio: nil)
            } label: {
                Label("Frei zuschneiden und bearbeiten…", systemImage: "slider.horizontal.3")
            }
            .disabled(viewModel.isLoading || viewModel.isSaving)
        } header: {
            Text("Zuschneiden")
        } footer: {
            Text("Ein Seitenverhältnis öffnet den Editor mit diesem Zuschnitt — auf das Motiv gesetzt, wenn die KI einen Vorschlag dafür hat. Dort kommen auch Drehung und Tonwerte dazu; gespeichert wird erst dort.")
        }
    }

    private func ratioChip(_ ratio: PhotoTransforms.AspectRatio) -> some View {
        let composed = viewModel.suggestedRatios.contains(ratio)
        return Button {
            editorTarget = EditorTarget(ratio: ratio)
        } label: {
            HStack(spacing: 4) {
                Text(ratio.rawValue)
                if composed {
                    // The AI has a framing for this one, so it opens on the
                    // subject rather than on the middle of the photo.
                    Image(systemName: "sparkles").font(.caption2)
                }
            }
            .font(.caption)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(Color.secondary.opacity(0.12), in: Capsule())
        }
        .buttonStyle(.plain)
        .disabled(viewModel.isLoading || viewModel.isSaving)
        .accessibilityLabel(
            composed
                ? "Seitenverhältnis \(ratio.rawValue), mit KI-Vorschlag"
                : "Seitenverhältnis \(ratio.rawValue)"
        )
    }

    // MARK: - Suggestion

    @ViewBuilder
    private var suggestionSection: some View {
        if !viewModel.suggestedRatios.isEmpty {
            Section {
                Picker("Seitenverhältnis", selection: $viewModel.previewRatio) {
                    ForEach(viewModel.suggestedRatios) { ratio in
                        Text(ratio.rawValue).tag(Optional(ratio))
                    }
                }
                .pickerStyle(.segmented)

                if let ratio = viewModel.previewRatio {
                    Button {
                        Task { await viewModel.apply(ratio: ratio) }
                    } label: {
                        Label("Vorschlag \(ratio.rawValue) übernehmen", systemImage: "sparkles")
                    }
                    .disabled(viewModel.isSaving)
                }
            } header: {
                Text("KI-Vorschlag")
            } footer: {
                Text("Nur Seitenverhältnisse, für die ein Gesicht als Bildmitte gefunden wurde. Vorschläge werden nie automatisch angewendet.")
            }
        } else if viewModel.bundle != nil {
            Section {
                Text("Für dieses Foto gibt es keinen Zuschnitt-Vorschlag — es wurde kein Gesicht erkannt, um den Bildausschnitt daran auszurichten. Die Seitenverhältnisse oben lassen sich trotzdem verwenden; der Zuschnitt startet dann mittig.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            } header: {
                Text("KI-Vorschlag")
            }
        }
    }

    // MARK: - Adopt

    @ViewBuilder
    private var adoptSection: some View {
        if !viewModel.adoptable.isEmpty {
            Section {
                ForEach(viewModel.adoptable) { other in
                    Button {
                        Task { await viewModel.adopt(other) }
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(other.user.name)
                            Text(PhotoTransforms.summary(of: other))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .disabled(viewModel.isSaving)
                }
            } header: {
                Text("Fassungen anderer")
            } footer: {
                Text("Übernimmt die Bearbeitung als deine eigene. Die des anderen bleibt unberührt.")
            }
        }
    }
}

/// A photo rendered through one recipe. Loads through the shared client so the
/// request carries the session, like every other image in the app.
struct TransformedPhotoView: View {
    let photoId: Int
    let variant: PhotoTransforms.Variant

    @State private var image: UIImage?
    @State private var isLoading = false

    var body: some View {
        ZStack {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
            } else if isLoading {
                ProgressView()
            } else {
                Image(systemName: "photo")
                    .font(.largeTitle)
                    .foregroundStyle(.secondary)
            }
        }
        .task(id: variant) { await load() }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        let data = try? await APIClient.shared.downloadData(
            PhotoTransforms.renderPath(photoId: photoId),
            query: PhotoTransforms.renderQuery(variant, width: 1200)
        )
        guard let data, let loaded = UIImage(data: data) else { return }
        image = loaded
    }
}

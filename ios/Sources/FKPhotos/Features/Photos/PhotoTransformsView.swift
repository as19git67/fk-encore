import SwiftUI
import UIKit

/// Reviewing a photo's non-destructive edits: what the AI proposes, what other
/// people in the household saved, and what this user has applied.
///
/// The web's `PhotoTransformEditor` in its review half (#1019, stage A). The
/// hand cropper and the tone sliders are stage B; everything here is a
/// confirmation of something the server already computed — apply a suggested
/// crop at one ratio, adopt someone else's recipe, or go back to the original.
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
    @MainActor
    private func mutate(_ work: () async throws -> Void) async {
        isSaving = true
        errorMessage = nil
        do {
            try await work()
            isSaving = false
            await load()
        } catch {
            errorMessage = error.localizedDescription
            isSaving = false
        }
    }
}

struct PhotoTransformsView: View {
    @State private var viewModel: PhotoTransformsViewModel
    @Environment(AuthManager.self) private var authManager
    @Environment(\.dismiss) private var dismiss

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
                Text("Für dieses Foto gibt es keinen Zuschnitt-Vorschlag — es wurde kein Gesicht erkannt, um den Bildausschnitt daran auszurichten.")
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

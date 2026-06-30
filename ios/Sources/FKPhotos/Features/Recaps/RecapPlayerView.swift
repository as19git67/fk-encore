import SwiftUI

/// Story-style, full-screen recap player: auto-advancing slides with a
/// segmented progress bar, tap-left/right to seek, long-press to pause and
/// swipe-down (or the X button) to dismiss. Read-only.
struct RecapPlayerView: View {
    let recapId: Int
    var onSeen: ((Int) -> Void)? = nil

    @Environment(\.dismiss) private var dismiss

    @State private var photos: [RecapPhoto] = []
    @State private var title: String = ""
    @State private var subtitle: String?
    @State private var isLoading = true
    @State private var loadError: String?
    @State private var playback = RecapPlayback(count: 0)
    @State private var isPaused = false
    @State private var ticker: Task<Void, Never>?

    /// Seconds each slide stays on screen before auto-advancing.
    private let perItem: Double = 4.0
    private let tickStep: Double = 0.05

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            content
        }
        .statusBarHidden(true)
        .task { await load() }
        .onDisappear { ticker?.cancel() }
    }

    @ViewBuilder
    private var content: some View {
        if isLoading {
            ProgressView().tint(.white)
        } else if let loadError {
            errorView(loadError)
        } else if photos.isEmpty {
            VStack(spacing: 12) {
                Text("Dieser Rückblick enthält keine Fotos.")
                    .foregroundStyle(.white)
                Button("Schließen") { dismiss() }.tint(.white)
            }
            .padding()
        } else {
            player
        }
    }

    private func errorView(_ message: String) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "exclamationmark.triangle")
                .font(.largeTitle)
                .foregroundStyle(.white)
            Text(message)
                .foregroundStyle(.white)
                .multilineTextAlignment(.center)
            Button("Schließen") { dismiss() }.tint(.white)
        }
        .padding()
    }

    private var player: some View {
        let idx = min(playback.index, max(0, photos.count - 1))
        return GeometryReader { geo in
            ZStack(alignment: .top) {
                RecapSlide(filename: photos[idx].filename)
                    .frame(width: geo.size.width, height: geo.size.height)
                    .clipped()
                    .id(photos[idx].id)

                // Tap zones: left third = back, right two-thirds = forward.
                HStack(spacing: 0) {
                    Color.clear
                        .frame(width: geo.size.width / 3)
                        .contentShape(Rectangle())
                        .onTapGesture { goPrevious() }
                    Color.clear
                        .contentShape(Rectangle())
                        .onTapGesture { goNext() }
                }

                topOverlay
            }
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 20)
                    .onEnded { value in
                        if value.translation.height > 80 { dismiss() }
                    }
            )
            .onLongPressGesture(minimumDuration: 0.2, pressing: { pressing in
                isPaused = pressing
            }, perform: {})
        }
        .ignoresSafeArea()
    }

    private var topOverlay: some View {
        VStack(spacing: 8) {
            HStack(spacing: 4) {
                ForEach(photos.indices, id: \.self) { i in
                    ProgressBar(fraction: playback.fillFraction(for: i))
                        .frame(height: 3)
                }
            }

            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.headline)
                        .foregroundStyle(.white)
                        .lineLimit(1)
                    if let subtitle, !subtitle.isEmpty {
                        Text(subtitle)
                            .font(.caption)
                            .foregroundStyle(.white.opacity(0.85))
                            .lineLimit(1)
                    }
                }
                Spacer()
                Button { dismiss() } label: {
                    Image(systemName: "xmark")
                        .font(.headline)
                        .foregroundStyle(.white)
                        .padding(8)
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 12)
        .background(
            LinearGradient(
                colors: [.black.opacity(0.55), .clear],
                startPoint: .top,
                endPoint: .bottom
            )
            .ignoresSafeArea(edges: .top)
        )
    }

    // MARK: - Loading

    private func load() async {
        isLoading = true
        do {
            let detail: GetRecapResponse = try await APIClient.shared.get("/recaps/\(recapId)")
            title = detail.recap.title
            subtitle = detail.recap.subtitle

            let ids = detail.recap.photo_ids
            if !ids.isEmpty {
                let query = ["ids": ids.map(String.init).joined(separator: ",")]
                let response: RecapPhotoDetailsResponse =
                    try await APIClient.shared.get("/photos/details", query: query)
                // The batch endpoint may reorder; restore the recap's order.
                let byId = Dictionary(response.photos.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
                photos = ids.compactMap { byId[$0] }
            }

            playback = RecapPlayback(count: photos.count)
            isLoading = false
            onSeen?(recapId)
            if !photos.isEmpty { startTicker() }
        } catch {
            loadError = error.localizedDescription
            isLoading = false
        }
    }

    // MARK: - Playback control

    private func startTicker() {
        ticker?.cancel()
        ticker = Task { @MainActor in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(tickStep))
                if Task.isCancelled { return }
                if isPaused { continue }
                playback.tick(delta: tickStep, perItem: perItem)
                if playback.finished {
                    dismiss()
                    return
                }
            }
        }
    }

    private func goNext() {
        playback.next()
        if playback.finished { dismiss() }
    }

    private func goPrevious() {
        playback.previous()
    }
}

/// One segment of the story progress bar.
private struct ProgressBar: View {
    let fraction: Double

    var body: some View {
        GeometryReader { geo in
            Capsule()
                .fill(.white.opacity(0.3))
                .overlay(alignment: .leading) {
                    Capsule()
                        .fill(.white)
                        .frame(width: geo.size.width * min(max(fraction, 0), 1))
                }
        }
    }
}

/// Loads and displays a single recap slide image, fit to the screen on black.
private struct RecapSlide: View {
    let filename: String
    @State private var loader: ThumbnailLoader

    init(filename: String) {
        self.filename = filename
        _loader = State(initialValue: ThumbnailLoader(filename: filename))
    }

    var body: some View {
        ZStack {
            Color.black
            if let image = loader.image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
            } else if loader.hasError {
                Image(systemName: "exclamationmark.triangle")
                    .font(.largeTitle)
                    .foregroundStyle(.white.opacity(0.6))
            } else {
                ProgressView().tint(.white)
            }
        }
        .task { await loader.load() }
    }
}

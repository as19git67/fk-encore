import SwiftUI

/// Story-style, full-screen recap player: auto-advancing slides with a
/// segmented progress bar, tap-left/right to seek, long-press to pause and
/// swipe-down (or the X button) to dismiss. Read-only.
///
/// Slides are prefetched a few positions ahead and rendered with a subtle
/// Ken-Burns motion plus a crossfade between slides, mirroring the web
/// player. While the current slide's image is still downloading, playback
/// progress is held so the slide never loses its screen time to a spinner.
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

    /// Loaded slide images keyed by position in `photos`.
    @State private var slideImages: [Int: UIImage] = [:]
    /// Slides whose download failed — rendered as an error glyph and skipped
    /// by the buffering gate so playback doesn't hang forever.
    @State private var failedSlides: Set<Int> = []
    /// Slide indices with an in-flight download (dedupes prefetch tasks).
    @State private var loadingSlides: Set<Int> = []

    /// Seconds each slide stays on screen before auto-advancing.
    private let perItem: Double = 4.0
    private let tickStep: Double = 0.05
    /// How many slides beyond the current one are fetched ahead of time.
    private let prefetchAhead = 3

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
                slideContent(idx: idx)
                    .frame(width: geo.size.width, height: geo.size.height)
                    .clipped()

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
        .onChange(of: playback.index) { _, newIndex in
            prefetch(around: newIndex)
        }
    }

    @ViewBuilder
    private func slideContent(idx: Int) -> some View {
        ZStack {
            Color.black
            if let image = slideImages[idx] {
                KenBurnsSlide(
                    image: image,
                    seed: photos[idx].id,
                    duration: perItem + 1.0
                )
                .id(photos[idx].id)
                .transition(.opacity.animation(.easeInOut(duration: 0.5)))
            } else if failedSlides.contains(idx) {
                Image(systemName: "exclamationmark.triangle")
                    .font(.largeTitle)
                    .foregroundStyle(.white.opacity(0.6))
            } else {
                ProgressView().tint(.white)
            }
        }
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
            if !photos.isEmpty {
                prefetch(around: 0)
                startTicker()
            }
        } catch {
            loadError = error.localizedDescription
            isLoading = false
        }
    }

    private func cacheKey(_ filename: String) -> String { "photo-\(filename)" }

    /// Kick off downloads for the slide at `idx` and the next few. Each slide
    /// is fetched at most once; results land in the shared `ImageCache`, so a
    /// replay or the photo grid can reuse them.
    private func prefetch(around idx: Int) {
        for i in idx...(idx + prefetchAhead) where i >= 0 && i < photos.count {
            guard slideImages[i] == nil,
                  !failedSlides.contains(i),
                  !loadingSlides.contains(i) else { continue }
            loadingSlides.insert(i)
            Task { await loadSlide(i) }
        }
    }

    @MainActor
    private func loadSlide(_ idx: Int) async {
        defer { loadingSlides.remove(idx) }
        let filename = photos[idx].filename

        if let cached = await ImageCache.shared.image(forKey: cacheKey(filename)) {
            slideImages[idx] = cached
            return
        }
        do {
            let data = try await APIClient.shared.downloadData("/photos/file/\(filename)")
            guard let image = UIImage(data: data) else {
                failedSlides.insert(idx)
                return
            }
            await ImageCache.shared.store(image, forKey: cacheKey(filename))
            slideImages[idx] = image
        } catch {
            failedSlides.insert(idx)
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
                // Buffering gate: hold progress while the current slide is
                // still downloading, so the photo gets its full screen time
                // once it appears (failed slides advance normally).
                let idx = playback.index
                if slideImages[idx] == nil && !failedSlides.contains(idx) { continue }
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

/// Renders one slide with a slow Ken-Burns pan/zoom. The motion is derived
/// deterministically from the photo id (same hash as the web player), so a
/// given photo always drifts the same way.
private struct KenBurnsSlide: View {
    let image: UIImage
    let seed: Int
    let duration: Double

    @State private var animate = false

    private struct Motion {
        let fromScale: CGFloat
        let toScale: CGFloat
        let fromX: CGFloat
        let fromY: CGFloat
        let toX: CGFloat
        let toY: CGFloat
    }

    private var motion: Motion {
        func r(_ x: Double) -> Double {
            let s = sin(Double(seed) * 9301 + x * 49297) * 233280
            return s - s.rounded(.down)
        }
        let zoomIn = r(1) > 0.5
        // Offsets are fractions of the slide size; the minimum scale of 1.06
        // leaves enough overscan that a ±1.5% pan never exposes an edge.
        let amp = 0.015
        return Motion(
            fromScale: zoomIn ? 1.06 : 1.18,
            toScale: zoomIn ? 1.18 : 1.06,
            fromX: CGFloat((r(2) - 0.5) * 2 * amp),
            fromY: CGFloat((r(3) - 0.5) * 2 * amp),
            toX: CGFloat((r(4) - 0.5) * 2 * amp),
            toY: CGFloat((r(5) - 0.5) * 2 * amp)
        )
    }

    var body: some View {
        let m = motion
        GeometryReader { geo in
            Image(uiImage: image)
                .resizable()
                .scaledToFill()
                .frame(width: geo.size.width, height: geo.size.height)
                .scaleEffect(animate ? m.toScale : m.fromScale)
                .offset(
                    x: (animate ? m.toX : m.fromX) * geo.size.width,
                    y: (animate ? m.toY : m.fromY) * geo.size.height
                )
                .onAppear {
                    withAnimation(.linear(duration: duration)) { animate = true }
                }
        }
        .clipped()
    }
}

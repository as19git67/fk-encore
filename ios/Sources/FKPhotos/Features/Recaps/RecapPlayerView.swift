import AVFoundation
import MapKit
import SwiftUI

/// Story-style, full-screen recap player: auto-advancing slides with a
/// segmented progress bar, tap-left/right to seek, long-press to pause and
/// swipe-down (or the X button) to dismiss. Read-only.
///
/// Slides are prefetched a few positions ahead and rendered with a subtle
/// Ken-Burns motion plus a crossfade between slides, mirroring the web
/// player. While the current slide's image is still downloading, playback
/// progress is held so the slide never loses its screen time to a spinner.
/// If the server suggests a background track (self-hosted recap music), it
/// loops behind the slides with a gentle fade and a mute toggle.
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

    @State private var musicPlayer: AVAudioPlayer?
    @State private var isMusicMuted = false
    /// Track cycle for "Andere Musik", ordered so the recap's suggested track
    /// leads; stepping wraps back to it. Empty / single => no change control.
    @State private var musicTracks: [RecapMusicTrack] = []
    @State private var musicCycleIndex = 0

    /// Trip map intro shown before the slideshow; nil once finished/skipped.
    @State private var mapIntro: RecapMapIntroData?

    /// "Damals & heute" intro on person recaps; nil once finished/skipped.
    @State private var compareIntro: RecapCompareIntroData?

    /// Local favorite toggles (photoId → isFavorite) shadowing the fetched
    /// curation_status; rolled back if the PATCH fails.
    @State private var favoriteOverrides: [Int: Bool] = [:]
    @State private var favoriteBusy = false

    private let musicVolume: Float = 0.55

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
        .onDisappear {
            ticker?.cancel()
            stopMusic()
        }
        .onChange(of: isPaused) { _, paused in
            guard let musicPlayer else { return }
            if paused {
                musicPlayer.pause()
            } else {
                musicPlayer.play()
            }
        }
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

                // Intros cover the first slide until they finish (or are
                // skipped by tap); the slideshow ticker starts after.
                if let intro = mapIntro {
                    RecapMapIntroView(data: intro) { finishIntro() }
                } else if let compare = compareIntro {
                    RecapCompareIntroView(data: compare) { finishIntro() }
                }

                topOverlay

                if mapIntro == nil && compareIntro == nil {
                    favoriteButton(for: idx)
                        .frame(
                            maxWidth: .infinity,
                            maxHeight: .infinity,
                            alignment: .bottomTrailing
                        )
                        .padding(.trailing, 16)
                        .padding(.bottom, 28)
                }
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
                    duration: perItem + 1.0,
                    focal: photos[idx].auto_crop.map { CGPoint(x: $0.x, y: $0.y) }
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
                if musicPlayer != nil {
                    Button { toggleMusicMuted() } label: {
                        Image(systemName: isMusicMuted ? "speaker.slash.fill" : "speaker.wave.2.fill")
                            .font(.headline)
                            .foregroundStyle(.white)
                            .padding(8)
                    }
                    .accessibilityLabel(isMusicMuted ? "Musik einschalten" : "Musik stummschalten")
                }
                if musicPlayer != nil && musicTracks.count > 1 {
                    Button { changeMusic() } label: {
                        Image(systemName: "forward.fill")
                            .font(.headline)
                            .foregroundStyle(.white)
                            .padding(8)
                    }
                    .accessibilityLabel("Andere Musik")
                }
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
            // The "Damals & heute" pair may reference photos outside the
            // curated recap membership — load them in the same batch.
            var compareIds: (then: Int, thenYear: Int, now: Int, nowYear: Int)?
            if detail.recap.recapKind == .person,
               let seed = detail.recap.seed,
               let thenId = seed.then_photo_id, let thenYear = seed.then_year,
               let nowId = seed.now_photo_id, let nowYear = seed.now_year,
               thenId != nowId {
                compareIds = (thenId, thenYear, nowId, nowYear)
            }
            if !ids.isEmpty {
                var fetchIds = ids
                if let c = compareIds {
                    for extra in [c.then, c.now] where !fetchIds.contains(extra) {
                        fetchIds.append(extra)
                    }
                }
                let query = ["ids": fetchIds.map(String.init).joined(separator: ",")]
                let response: RecapPhotoDetailsResponse =
                    try await APIClient.shared.get("/photos/details", query: query)
                // The batch endpoint may reorder; restore the recap's order.
                let byId = Dictionary(response.photos.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
                photos = ids.compactMap { byId[$0] }
                if let c = compareIds, let then = byId[c.then], let now = byId[c.now] {
                    compareIntro = RecapCompareIntroData(
                        then: then, thenYear: c.thenYear,
                        now: now, nowYear: c.nowYear
                    )
                }
            }

            playback = RecapPlayback(count: photos.count)
            isLoading = false
            onSeen?(recapId)
            if !photos.isEmpty {
                if detail.recap.recapKind == .trip,
                   let seed = detail.recap.seed,
                   let toLat = seed.centroid_lat, let toLon = seed.centroid_lon {
                    var from: CLLocationCoordinate2D?
                    if let hLat = seed.home_lat, let hLon = seed.home_lon {
                        from = CLLocationCoordinate2D(latitude: hLat, longitude: hLon)
                    }
                    mapIntro = RecapMapIntroData(
                        from: from,
                        to: CLLocationCoordinate2D(latitude: toLat, longitude: toLon),
                        label: seed.location_city
                    )
                }
                prefetch(around: 0)
                // With an intro (map or compare) the ticker starts once it
                // finishes, so the first photo keeps its full screen time.
                if mapIntro == nil && compareIntro == nil { startTicker() }
                if let track = detail.music {
                    Task { await startMusic(track) }
                    Task { await loadMusicCycle(suggested: track) }
                }
            }
        } catch {
            loadError = error.localizedDescription
            isLoading = false
        }
    }

    private func finishIntro() {
        guard mapIntro != nil || compareIntro != nil else { return }
        mapIntro = nil
        compareIntro = nil
        startTicker()
    }

    // MARK: - Favorites

    private func isFavorite(_ photo: RecapPhoto) -> Bool {
        favoriteOverrides[photo.id] ?? (photo.curation_status == "favorite")
    }

    private func favoriteButton(for idx: Int) -> some View {
        let fav = idx < photos.count ? isFavorite(photos[idx]) : false
        return Button { toggleFavorite(at: idx) } label: {
            Image(systemName: fav ? "heart.fill" : "heart")
                .font(.title2)
                .foregroundStyle(fav ? .red : .white)
                .padding(12)
                .background(.black.opacity(0.45), in: Circle())
        }
        .disabled(favoriteBusy)
        .accessibilityLabel(fav ? "Favorit entfernen" : "Als Favorit markieren")
    }

    private func toggleFavorite(at idx: Int) {
        guard idx < photos.count, !favoriteBusy else { return }
        let photo = photos[idx]
        let target = !isFavorite(photo)
        favoriteOverrides[photo.id] = target
        favoriteBusy = true
        Task { @MainActor in
            defer { favoriteBusy = false }
            struct CurationBody: Encodable { let status: String }
            struct CurationResponse: Decodable { let success: Bool }
            do {
                let _: CurationResponse = try await APIClient.shared.patch(
                    "/photos/\(photo.id)/curation",
                    body: CurationBody(status: target ? "favorite" : "visible")
                )
            } catch {
                favoriteOverrides[photo.id] = !target
            }
        }
    }

    // MARK: - Music

    /// Download the suggested track and loop it behind the slides. Any
    /// failure keeps the recap silent — music is never worth an error UI.
    @MainActor
    private func startMusic(_ track: RecapMusicTrack) async {
        do {
            // `track.id` is the raw "<mood>/<filename>" pair; APIClient
            // percent-encodes paths itself, so don't use the pre-encoded url.
            let data = try await APIClient.shared.downloadData("/recaps-music/file/\(track.id)")
            let player = try AVAudioPlayer(data: data)
            player.numberOfLoops = -1
            player.volume = 0
            try? AVAudioSession.sharedInstance().setCategory(.playback)
            try? AVAudioSession.sharedInstance().setActive(true)
            guard !Task.isCancelled, !playback.finished else { return }
            player.play()
            player.setVolume(isMusicMuted ? 0 : musicVolume, fadeDuration: 1.5)
            musicPlayer = player
        } catch {
            // Silent recap — intentionally no error surface.
        }
    }

    private func stopMusic() {
        guard let player = musicPlayer else { return }
        musicPlayer = nil
        player.setVolume(0, fadeDuration: 0.3)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
            player.stop()
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
    }

    /// Order the track list so the recap's suggested track leads, enabling a
    /// wrap-around cycle. Mirrors the web player's `orderedTrackCycle`.
    static func orderedMusicCycle(
        _ tracks: [RecapMusicTrack],
        suggestedId: String
    ) -> [RecapMusicTrack] {
        guard !tracks.isEmpty else { return [] }
        let start = tracks.firstIndex(where: { $0.id == suggestedId }) ?? 0
        return Array(tracks[start...] + tracks[..<start])
    }

    /// Fetch the full track list and build the cycle. Failure leaves the recap
    /// with just its suggested track (no change control) — never an error UI.
    @MainActor
    private func loadMusicCycle(suggested: RecapMusicTrack) async {
        guard
            let resp: RecapMusicListResponse = try? await APIClient.shared.get("/recaps-music")
        else { return }
        let ordered = Self.orderedMusicCycle(resp.tracks, suggestedId: suggested.id)
        if ordered.count > 1 {
            musicTracks = ordered
            musicCycleIndex = 0
        }
    }

    /// Step to the next track, wrapping back to the suggested one. Fades the
    /// old player out without deactivating the session so the new track can
    /// take over seamlessly.
    private func changeMusic() {
        guard musicTracks.count > 1 else { return }
        musicCycleIndex = (musicCycleIndex + 1) % musicTracks.count
        let next = musicTracks[musicCycleIndex]
        if let old = musicPlayer {
            musicPlayer = nil
            old.setVolume(0, fadeDuration: 0.3)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { old.stop() }
        }
        Task { await startMusic(next) }
    }

    private func toggleMusicMuted() {
        isMusicMuted.toggle()
        musicPlayer?.setVolume(isMusicMuted ? 0 : musicVolume, fadeDuration: 0.3)
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

/// Coordinates for the trip map intro, derived from the recap seed.
private struct RecapMapIntroData {
    /// Home location; nil for recaps built before home was persisted.
    let from: CLLocationCoordinate2D?
    let to: CLLocationCoordinate2D
    let label: String?
}

/// Animated map intro for trip recaps: starts framed on home, then flies the
/// camera out to frame the dashed route to the destination. Tap anywhere to
/// skip. With no home coordinates it zooms from a wide view onto the
/// destination instead.
private struct RecapMapIntroView: View {
    let data: RecapMapIntroData
    let onFinished: () -> Void

    @State private var camera: MapCameraPosition

    init(data: RecapMapIntroData, onFinished: @escaping () -> Void) {
        self.data = data
        self.onFinished = onFinished
        let startCenter = data.from ?? data.to
        let startSpan = data.from == nil
            ? MKCoordinateSpan(latitudeDelta: 40, longitudeDelta: 40)
            : MKCoordinateSpan(latitudeDelta: 1.2, longitudeDelta: 1.2)
        _camera = State(initialValue: .region(
            MKCoordinateRegion(center: startCenter, span: startSpan)
        ))
    }

    var body: some View {
        Map(position: $camera, interactionModes: []) {
            if let from = data.from {
                MapPolyline(coordinates: [from, data.to])
                    .stroke(.white, style: StrokeStyle(lineWidth: 3, dash: [4, 8]))
                Annotation("", coordinate: from) {
                    ZStack {
                        Circle().fill(.white).frame(width: 14, height: 14)
                        Circle().fill(.blue).frame(width: 10, height: 10)
                    }
                }
            }
            Annotation(data.label ?? "", coordinate: data.to) {
                ZStack {
                    Circle().fill(.white).frame(width: 18, height: 18)
                    Circle().fill(.red).frame(width: 13, height: 13)
                }
            }
        }
        .mapStyle(.standard(elevation: .flat))
        .environment(\.colorScheme, .dark)
        .contentShape(Rectangle())
        .onTapGesture { onFinished() }
        .task {
            try? await Task.sleep(for: .seconds(0.7))
            guard !Task.isCancelled else { return }
            withAnimation(.easeInOut(duration: 2.8)) {
                camera = .region(Self.region(
                    containing: [data.from, data.to].compactMap { $0 }
                ))
            }
            try? await Task.sleep(for: .seconds(4.0))
            guard !Task.isCancelled else { return }
            onFinished()
        }
    }

    /// Region framing all coordinates with padding; guards against a zero
    /// span when home and destination share an axis.
    private static func region(
        containing coords: [CLLocationCoordinate2D]
    ) -> MKCoordinateRegion {
        guard let first = coords.first else {
            return MKCoordinateRegion(
                center: CLLocationCoordinate2D(latitude: 0, longitude: 0),
                span: MKCoordinateSpan(latitudeDelta: 60, longitudeDelta: 60)
            )
        }
        var minLat = first.latitude
        var maxLat = first.latitude
        var minLon = first.longitude
        var maxLon = first.longitude
        for c in coords {
            minLat = min(minLat, c.latitude)
            maxLat = max(maxLat, c.latitude)
            minLon = min(minLon, c.longitude)
            maxLon = max(maxLon, c.longitude)
        }
        let center = CLLocationCoordinate2D(
            latitude: (minLat + maxLat) / 2,
            longitude: (minLon + maxLon) / 2
        )
        let span = MKCoordinateSpan(
            latitudeDelta: max(0.5, (maxLat - minLat) * 1.6),
            longitudeDelta: max(0.5, (maxLon - minLon) * 1.6)
        )
        return MKCoordinateRegion(center: center, span: span)
    }
}

/// Data for the "Damals & heute" intro on person recaps.
private struct RecapCompareIntroData {
    let then: RecapPhoto
    let thenYear: Int
    let now: RecapPhoto
    let nowYear: Int
}

/// Split-screen "Damals & heute" intro: the person's oldest photo next to
/// the newest, with year chips. Side-by-side in landscape, stacked in
/// portrait. Tap anywhere to skip; auto-advances after a few seconds.
private struct RecapCompareIntroView: View {
    let data: RecapCompareIntroData
    let onFinished: () -> Void

    private let displaySeconds: Double = 5.5

    var body: some View {
        GeometryReader { geo in
            let landscape = geo.size.width > geo.size.height
            let layout = landscape
                ? AnyLayout(HStackLayout(spacing: 6))
                : AnyLayout(VStackLayout(spacing: 6))
            layout {
                CompareTile(
                    filename: data.then.filename,
                    label: "Damals · \(data.thenYear)"
                )
                CompareTile(
                    filename: data.now.filename,
                    label: "Heute · \(data.nowYear)"
                )
            }
            .padding(6)
        }
        .background(Color.black)
        .contentShape(Rectangle())
        .onTapGesture { onFinished() }
        .task {
            try? await Task.sleep(for: .seconds(displaySeconds))
            guard !Task.isCancelled else { return }
            onFinished()
        }
    }
}

/// One half of the compare intro: image (aspect fill) with a year chip.
private struct CompareTile: View {
    let label: String
    @State private var loader: ThumbnailLoader

    init(filename: String, label: String) {
        self.label = label
        _loader = State(initialValue: ThumbnailLoader(filename: filename))
    }

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .bottom) {
                Color.black
                if let image = loader.image {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFill()
                        .frame(width: geo.size.width, height: geo.size.height)
                        .clipped()
                } else {
                    ProgressView().tint(.white)
                        .frame(width: geo.size.width, height: geo.size.height)
                }
                Text(label)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 5)
                    .background(.black.opacity(0.65), in: Capsule())
                    .padding(.bottom, 12)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .task { await loader.load() }
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
/// given photo always drifts the same way. When a focal point (`auto_crop`)
/// is present, the fill crop is shifted so faces stay in view instead of
/// the geometric centre.
private struct KenBurnsSlide: View {
    let image: UIImage
    let seed: Int
    let duration: Double
    var focal: CGPoint? = nil

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
            let base = focalOffset(in: geo.size)
            Image(uiImage: image)
                .resizable()
                .scaledToFill()
                .frame(width: geo.size.width, height: geo.size.height)
                .scaleEffect(animate ? m.toScale : m.fromScale)
                .offset(
                    x: base.width + (animate ? m.toX : m.fromX) * geo.size.width,
                    y: base.height + (animate ? m.toY : m.fromY) * geo.size.height
                )
                .onAppear {
                    withAnimation(.linear(duration: duration)) { animate = true }
                }
        }
        .clipped()
    }

    /// `scaledToFill` centres the image; this shifts the crop so the focal
    /// point moves towards the visible area. The offset is bounded by half
    /// the fill overflow per axis (focal 0/1 aligns the image edge with the
    /// container edge), matching CSS `object-position` semantics.
    private func focalOffset(in size: CGSize) -> CGSize {
        guard let focal else { return .zero }
        let img = image.size
        guard img.width > 0, img.height > 0, size.width > 0, size.height > 0 else {
            return .zero
        }
        let scale = max(size.width / img.width, size.height / img.height)
        let overflowX = max(0, img.width * scale - size.width)
        let overflowY = max(0, img.height * scale - size.height)
        let fx = min(max(focal.x, 0), 1)
        let fy = min(max(focal.y, 0), 1)
        return CGSize(
            width: (0.5 - fx) * overflowX,
            height: (0.5 - fy) * overflowY
        )
    }
}

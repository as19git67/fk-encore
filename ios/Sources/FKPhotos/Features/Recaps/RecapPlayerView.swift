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
    @State private var playback = SlideshowPlayback()
    /// How the photos are grouped into slides — see `SlideshowPlanner`. Two
    /// landscape photos share one portrait screen (and vice versa).
    @State private var plan: [SlideshowSlide] = []
    @State private var screen: ScreenOrientation = .portrait
    @State private var isPaused = false
    @State private var ticker: Task<Void, Never>?
    /// Consecutive ticks spent waiting for the planner; see `awaitPlan()`.
    @State private var stalledTicks = 0

    /// Downloads and holds the slide images; shared with the photo slideshow.
    @State private var store = SlideshowImageStore()

    /// Background music; shared with the photo slideshow. The recap's own
    /// suggested track leads the cycle.
    @State private var music = SlideshowMusic()

    /// Trip map intro shown before the slideshow; nil once finished/skipped.
    @State private var mapIntro: RecapMapIntroData?

    /// "Damals & heute" intro on person recaps; nil once finished/skipped.
    @State private var compareIntro: RecapCompareIntroData?

    /// Local favorite toggles (photoId → isFavorite) shadowing the fetched
    /// curation_status; rolled back if the PATCH fails.
    @State private var favoriteOverrides: [Int: Bool] = [:]
    @State private var favoriteBusy = false
    @State private var excludeBusy = false

    /// Seconds each slide stays on screen before auto-advancing.
    private let perItem: Double = 4.0
    private let tickStep: Double = 0.05
    /// How long the ticker holds out for a photo that would let the planner
    /// decide a pairing, before showing what it has as a single slide.
    private let planStallGrace: Double = 2.0
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
            music.stop()
        }
        .onChange(of: isPaused) { _, paused in
            music.setPaused(paused)
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
        GeometryReader { geo in
            let orientation = ScreenOrientation(size: geo.size)
            // `ignoresSafeArea()` has to sit on the *content* below, not on
            // this reader — applied to the reader itself, it reports zero
            // safeAreaInsets (the reader has already been expanded to cover
            // the safe area before its closure runs, so from its own
            // perspective there is nothing left to inset by). That silently
            // put the chrome back at the unfixed 12 pt-from-glass position,
            // right under the Dynamic Island, despite `chrome` existing.
            let chrome = SlideshowChromeInsets(safeArea: geo.safeAreaInsets)
            ZStack(alignment: .top) {
                slideContent(screen: orientation)
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

                topOverlay(chrome)

                if mapIntro == nil && compareIntro == nil {
                    favoriteButton
                        .frame(
                            maxWidth: .infinity,
                            maxHeight: .infinity,
                            alignment: .bottomTrailing
                        )
                        .padding(.trailing, 16 + chrome.trailing)
                        .padding(.bottom, 28 + chrome.bottom)

                    excludeButton
                        .frame(
                            maxWidth: .infinity,
                            maxHeight: .infinity,
                            alignment: .bottomLeading
                        )
                        .padding(.leading, 16 + chrome.leading)
                        .padding(.bottom, 28 + chrome.bottom)
                }
            }
            // Pin the player to the screen. A `ZStack` grows to its widest
            // child, so an overlay that cannot fit — the progress strip, once —
            // would otherwise drag the photo out of the frame with it.
            .frame(width: geo.size.width, height: geo.size.height, alignment: .top)
            .clipped()
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
            .onAppear {
                screen = orientation
                extendPlan()
            }
            .onChange(of: orientation) { _, new in
                screen = new
                replanForOrientationChange()
            }
            .ignoresSafeArea()
        }
        // Newly arrived images unlock pairing decisions for the photos after
        // the one on screen, so the plan grows as the recap runs.
        .onChange(of: store.images.count) { _, _ in extendPlan() }
        .onChange(of: store.failed.count) { _, _ in extendPlan() }
        .onChange(of: playback.slideIndex) { _, _ in
            if let slide = currentSlide {
                store.prefetch(around: slide.first, ahead: prefetchAhead)
            }
        }
    }

    @ViewBuilder
    private func slideContent(screen orientation: ScreenOrientation) -> some View {
        if let slide = currentSlide {
            SlideshowStageView(
                frames: slide.photoIndices.map { index in
                    SlideshowFrame(
                        id: photos[index].id,
                        image: store.images[index],
                        failed: store.failed.contains(index),
                        focal: photos[index].auto_crop.map { CGPoint(x: $0.x, y: $0.y) }
                    )
                },
                screen: orientation,
                duration: perItem + 1.0
            )
            .id(slide.photoIndices.map { String(photos[$0].id) }.joined(separator: "+"))
        } else {
            ZStack {
                Color.black
                ProgressView().tint(.white)
            }
        }
    }

    // MARK: - Slide plan

    private var currentSlide: SlideshowSlide? {
        playback.currentSlide(in: plan)
    }

    /// True once every photo has been assigned to a slide — only then does
    /// running off the last slide end the recap.
    private var planComplete: Bool {
        SlideshowPlanner.plannedPhotoCount(plan) >= photos.count
    }

    /// Commit slides for the photos whose shape is now known. `force` also
    /// commits an undecidable photo as a single slide, which is what breaks a
    /// stall when a download is slow.
    private func extendPlan(force: Bool = false) {
        let extended = SlideshowPlanner.extend(
            plan: plan,
            orientations: store.orientations,
            screen: screen,
            force: force
        )
        if extended != plan { plan = extended }
    }

    /// Turning the phone changes which photos are worth pairing. Slides already
    /// shown keep their numbering — only the unplayed tail is rebuilt.
    private func replanForOrientationChange() {
        let keep = min(playback.slideIndex + 1, plan.count)
        plan = Array(plan.prefix(keep))
        extendPlan()
    }

    private func topOverlay(_ chrome: SlideshowChromeInsets) -> some View {
        VStack(spacing: 8) {
            SlideshowProgressTrack(
                photoCount: photos.count,
                fill: { playback.fillFraction(forPhotoAt: $0, plan: plan) },
                overall: playback.overallFraction(
                    plan: plan,
                    photoCount: photos.count
                )
            )

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
                if music.isPlaying {
                    Button { music.toggleMuted() } label: {
                        Image(systemName: music.isMuted ? "speaker.slash.fill" : "speaker.wave.2.fill")
                            .font(.headline)
                            .foregroundStyle(.white)
                            .padding(8)
                    }
                    .accessibilityLabel(music.isMuted ? "Musik einschalten" : "Musik stummschalten")
                }
                if music.canChangeTrack {
                    Button { music.next() } label: {
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
        .padding(.leading, chrome.leading)
        .padding(.trailing, chrome.trailing)
        .padding(.top, chrome.top)
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

            playback = SlideshowPlayback()
            plan = []
            store.reset(photos: photos.map { SlideshowImageStore.Item(id: $0.id, filename: $0.filename) })
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
                store.prefetch(around: 0, ahead: prefetchAhead)
                // With an intro (map or compare) the ticker starts once it
                // finishes, so the first photo keeps its full screen time.
                if mapIntro == nil && compareIntro == nil { startTicker() }
                if let track = detail.music {
                    Task { await music.start(suggestedId: track.id, fallback: track) }
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

    /// Marks everything on the current slide as a favourite — on a pair both
    /// photos, since the tap means "this, on screen, now".
    private var favoriteButton: some View {
        let slidePhotos = (currentSlide?.photoIndices ?? []).map { photos[$0] }
        let fav = !slidePhotos.isEmpty && slidePhotos.allSatisfy { isFavorite($0) }
        return Button { toggleFavorite(allFavorite: fav) } label: {
            Image(systemName: fav ? "heart.fill" : "heart")
                .font(.title2)
                .foregroundStyle(fav ? .red : .white)
                .padding(12)
                .background(.black.opacity(0.45), in: Circle())
        }
        .disabled(favoriteBusy || slidePhotos.isEmpty)
        .accessibilityLabel(fav ? "Favorit entfernen" : "Als Favorit markieren")
    }

    private func toggleFavorite(allFavorite: Bool) {
        guard let slide = currentSlide, !favoriteBusy else { return }
        let targets = slide.photoIndices.map { photos[$0] }
        let target = !allFavorite
        let previous = targets.map { isFavorite($0) }
        for photo in targets { favoriteOverrides[photo.id] = target }
        favoriteBusy = true
        Task { @MainActor in
            defer { favoriteBusy = false }
            struct CurationBody: Encodable { let status: String }
            struct CurationResponse: Decodable { let success: Bool }
            for (photo, old) in zip(targets, previous) {
                do {
                    let _: CurationResponse = try await APIClient.shared.patch(
                        "/photos/\(photo.id)/curation",
                        body: CurationBody(status: target ? "favorite" : "visible")
                    )
                } catch {
                    favoriteOverrides[photo.id] = old
                }
            }
        }
    }

    // MARK: - Exclude

    private var excludeButton: some View {
        Button { excludeCurrentPhoto() } label: {
            Image(systemName: "nosign")
                .font(.title2)
                .foregroundStyle(.white)
                .padding(12)
                .background(.black.opacity(0.45), in: Circle())
        }
        .disabled(excludeBusy || photos.isEmpty)
        .accessibilityLabel("Foto aus Rückblick entfernen")
    }

    /// Persistently remove the current photo from the recap. The server
    /// backfills the next-best photo; we refresh the membership in place and
    /// restart the photo sequence (the intro is not replayed). Failures keep
    /// the show running unchanged.
    private func excludeCurrentPhoto() {
        guard !excludeBusy, !photos.isEmpty else { return }
        // On a pair the first of the two is the one the button removes; a
        // second tap then catches the other.
        let idx = currentSlide?.first ?? 0
        guard idx < photos.count else { return }
        let photoId = photos[idx].id
        excludeBusy = true
        Task { @MainActor in
            defer { excludeBusy = false }
            struct EmptyBody: Encodable {}
            struct ExcludeResponse: Decodable { let photo_ids: [Int] }
            do {
                let res: ExcludeResponse = try await APIClient.shared.post(
                    "/recaps/\(recapId)/photos/\(photoId)/exclude",
                    body: EmptyBody()
                )
                guard !res.photo_ids.isEmpty else { return }
                let query = ["ids": res.photo_ids.map(String.init).joined(separator: ",")]
                let response: RecapPhotoDetailsResponse =
                    try await APIClient.shared.get("/photos/details", query: query)
                let byId = Dictionary(
                    response.photos.map { ($0.id, $0) },
                    uniquingKeysWith: { first, _ in first }
                )
                let ordered = res.photo_ids.compactMap { byId[$0] }
                guard !ordered.isEmpty else { return }
                photos = ordered
                store.reset(photos: ordered.map { SlideshowImageStore.Item(id: $0.id, filename: $0.filename) })
                plan = []
                playback = SlideshowPlayback()
                store.prefetch(around: 0, ahead: prefetchAhead)
            } catch {
                // Keep the show running on any failure.
            }
        }
    }

    /// Counts a tick spent waiting for the planner and reports whether the wait
    /// has gone on long enough to stop holding out for a pairing partner.
    private func awaitPlan() -> Bool {
        stalledTicks += 1
        guard Double(stalledTicks) * tickStep >= planStallGrace else { return false }
        stalledTicks = 0
        return true
    }

    // MARK: - Playback control

    private func startTicker() {
        ticker?.cancel()
        ticker = Task { @MainActor in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(tickStep))
                if Task.isCancelled { return }
                if isPaused { continue }

                guard let slide = currentSlide else {
                    // Nothing planned to show yet. Planning waits for the next
                    // photo's size before it can pair the current one, so give
                    // that a moment before falling back to a single slide.
                    extendPlan()
                    if awaitPlan() { extendPlan(force: true) }
                    continue
                }
                // Buffering gate: hold progress while a photo of this slide is
                // still downloading, so it gets its full screen time once it
                // appears (failed photos count as settled and advance).
                guard slide.photoIndices.allSatisfy({ store.isSettled($0) }) else { continue }

                playback.tick(
                    delta: tickStep,
                    perSlide: perItem,
                    slideCount: plan.count,
                    planComplete: planComplete
                )
                if playback.finished {
                    dismiss()
                    return
                }
                // Parked at the end of the planned slides with photos left:
                // the plan has to give, or the recap would hang here.
                if playback.progress >= 1 && !planComplete {
                    if awaitPlan() { extendPlan(force: true) }
                } else {
                    stalledTicks = 0
                }
            }
        }
    }

    private func goNext() {
        if !planComplete { extendPlan(force: true) }
        playback.next(slideCount: plan.count, planComplete: planComplete)
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
                    photoId: data.then.id,
                    filename: data.then.filename,
                    label: "Damals · \(data.thenYear)"
                )
                CompareTile(
                    photoId: data.now.id,
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

    init(photoId: Int?, filename: String, label: String) {
        self.label = label
        _loader = State(initialValue: ThumbnailLoader(filename: filename, photoId: photoId))
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
